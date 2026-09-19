#!/usr/bin/env bash
set -euo pipefail

# axa-chat installer
#
#   curl -fsSL https://raw.githubusercontent.com/cristianizzo/axa-chat/main/install.sh | bash
#
# This script downloads a prebuilt binary. It does not clone, it does not need
# bun, git or a toolchain, and it never compiles anything on your machine.
#
# Why curl is the documented channel and not a browser download: macOS sets the
# `com.apple.quarantine` extended attribute from the *downloading application*.
# curl sets none, so Gatekeeper never assesses the binary and no Apple signing
# identity is involved. A browser download is quarantined, and a bare Mach-O
# cannot be stapled, so it is hard-blocked with no right-click-Open escape. If
# you download the tarball by hand, see the README: you have to strip the
# attribute yourself.
#
# Layout it produces (all overridable, see the env vars below):
#
#   ~/.local/share/axa/versions/<version>   bare executables, 3 retained
#   ~/.local/share/axa/staging/             download + verify, cleared after
#   ~/.local/share/axa/previous             the version to roll back to
#   ~/.local/bin/axa                        symlink -> versions/<version>
#
# Rollback, if a release is bad:
#
#   curl -fsSL .../install.sh | bash -s -- --rollback
#
# or, with nothing but a shell — this is the line worth remembering, because a
# broken update path cannot fix itself:
#
#   ln -sfn ~/.local/share/axa/versions/<version> ~/.local/bin/axa

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

REPO_SLUG="cristianizzo/axa-chat"
# The channel lives in the URL from the first release rather than being added
# later. Publishing a `dev` channel then costs one more manifest; retrofitting a
# channel into a URL that installed scripts have already baked in is a migration.
CHANNEL="${AXA_CHANNEL:-stable}"
# AXA_RELEASE_BASE exists so this script can be run end to end against a local
# origin before it is ever pointed at a real one. Stated rather than hidden: an
# undocumented env var that redirects a download is worse than a documented one,
# and anyone who can set your environment can already replace the binary it
# would fetch.
RELEASE_BASE="${AXA_RELEASE_BASE:-https://github.com/${REPO_SLUG}/releases/download}"

# Both halves of every AXA_* name here are ours (this script and
# src/utils/binaryUpdate.ts), so they are safe to rename provided both move
# together. They exist so the installer can be tested against a throwaway
# prefix instead of a real home directory.
BIN_DIR="${AXA_BIN_DIR:-$HOME/.local/bin}"
DATA_DIR="${AXA_DATA_DIR:-$HOME/.local/share/axa}"
VERSIONS_DIR="$DATA_DIR/versions"
# Staging sits inside DATA_DIR, not in ~/.cache, so that the move into
# versions/ is a rename(2) on one filesystem and therefore atomic. It is still
# outside versions/, so a half-downloaded file is never a candidate version.
STAGING_DIR="$DATA_DIR/staging"
PREVIOUS_FILE="$DATA_DIR/previous"
LAUNCHER="$BIN_DIR/axa"
RETAIN=3

# How to invoke this script again, in a form the reader can actually paste.
# `$0` is a usable path when the file was downloaded, and the useless string
# `bash` when it was piped from curl — which is the documented channel, so it is
# the case the hint has to be right for.
if [ -f "$0" ] && [ "$(basename "$0")" != "bash" ]; then
  SELF="$0"
else
  SELF="curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh | bash -s --"
fi

info()  { printf "${CYAN}[*]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[+]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
fail()  { printf "${RED}[x]${RESET} %s\n" "$*" >&2; exit 1; }

header() {
  echo ""
  printf "${BOLD}${CYAN}"
  cat << 'ART'
                              _           _
   __ ___  ____ _        ___| |__   __ _| |_
  / _` \ \/ / _` |_____ / __| '_ \ / _` | __|
 | (_| |>  < (_| |_____| (__| | | | (_| | |_
  \__,_/_/\_\__,_|      \___|_| |_|\__,_|\__|

ART
  printf "${RESET}"
  printf "${DIM}  Multi-provider AI coding CLI${RESET}\n"
  echo ""
}

usage() {
  cat <<'EOF'
Usage: install.sh [--rollback] [--list-versions] [--version <v>] [--help]

  (no flags)        install or update to the latest release on the channel
  --rollback        point the launcher back at the previously active version
  --list-versions   show what is installed and which one is active
  --version <v>     install a specific version instead of the channel's latest

Environment:
  AXA_CHANNEL       release channel (default: stable)
  AXA_BIN_DIR       where the launcher symlink goes (default: ~/.local/bin)
  AXA_DATA_DIR      where versions live (default: ~/.local/share/axa)
  AXA_RELEASE_BASE  where releases are fetched from (default: GitHub Releases)
EOF
}

# -------------------------------------------------------------------
# System checks
# -------------------------------------------------------------------

# macOS only, deliberately. Earlier versions of this script advertised Linux
# and could not deliver it: the build is host-targeted, there was never a Linux
# artifact, and promising one is worse than not offering it. If Linux is wanted
# it is a new decision and a new runner, not a flag.
check_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  if [ "$os" != "Darwin" ]; then
    fail "axa is published for macOS only.
    This machine reports \"$os\". There is no Linux or Windows build to
    download — not a missing flag, a missing artifact. Build from source
    instead: https://github.com/${REPO_SLUG}#building-from-source"
  fi

  case "$arch" in
    arm64) PLATFORM="darwin-arm64" ;;
    x86_64)
      fail "axa is published for Apple Silicon (arm64) only, and this Mac
    reports x86_64. Rosetta will not help: the download simply does not exist.
    Build from source instead:
      https://github.com/${REPO_SLUG}#building-from-source"
      ;;
    *) fail "Unsupported architecture: $arch" ;;
  esac

  ok "Platform: macOS $arch ($PLATFORM)"
}

# Every one of these ships with macOS. They are checked anyway because the
# failure of a missing one is otherwise a confusing error several steps later,
# on a partially-written install directory.
check_tools() {
  local missing=()
  for tool in curl tar shasum mktemp; do
    command -v "$tool" &>/dev/null || missing+=("$tool")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    fail "Required tools are missing: ${missing[*]}
    All of these ship with macOS, so a missing one usually means a broken PATH."
  fi
}

# -------------------------------------------------------------------
# Resolving the release
# -------------------------------------------------------------------

# The channel pointer is a plain-text file holding nothing but a version, for
# the same reason the reference implementation uses one: this script has no JSON
# parser it can rely on, and hand-rolling one in bash for the single file that
# must never fail is how installers break. The machine-readable manifest.json is
# published beside it and is what the in-process updater reads.
resolve_version() {
  if [ -n "${REQUESTED_VERSION:-}" ]; then
    VERSION="$REQUESTED_VERSION"
    ok "Version: $VERSION (requested)"
    return
  fi

  local url raw
  url="${RELEASE_BASE}/${CHANNEL}/VERSION"
  info "Resolving the latest ${CHANNEL} release..."
  raw="$(curl -fsSL --max-time 60 "$url" 2>/dev/null || true)"
  # Strip whitespace/CR rather than trusting the file to be exact: it is
  # produced by CI, and a stray newline would end up in a directory name.
  raw="$(printf '%s' "$raw" | tr -d '[:space:]')"

  if [ -z "$raw" ]; then
    fail "Could not read the ${CHANNEL} channel pointer at
      $url
    Either there is no published release on this channel yet, or the network
    is blocked. Nothing on this machine was changed."
  fi
  # A version is what names a directory below, so validate its shape before it
  # is ever interpolated into a path.
  if [[ ! "$raw" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]]; then
    fail "The ${CHANNEL} channel pointer contains something that is not a
    version: \"$raw\". Refusing to use it as a directory name."
  fi

  VERSION="$raw"
  ok "Latest ${CHANNEL} release: $VERSION"
}

# -------------------------------------------------------------------
# Download, verify, stage
# -------------------------------------------------------------------

download_and_verify() {
  local tag="v${VERSION}"
  local archive="axa-${VERSION}-${PLATFORM}.tar.gz"
  local archive_url="${RELEASE_BASE}/${tag}/${archive}"
  local sums_url="${archive_url}.sha256"

  rm -rf "$STAGING_DIR"
  mkdir -p "$STAGING_DIR"

  info "Downloading ${archive}..."
  if ! curl -fSL --max-time 900 --progress-bar "$archive_url" -o "$STAGING_DIR/$archive"; then
    rm -rf "$STAGING_DIR"
    fail "Failed to download
      $archive_url
    Nothing on this machine was changed."
  fi

  # The checksum is fetched separately rather than trusted from the same stream
  # it validates. It buys integrity against a truncated or corrupted transfer,
  # not authenticity — both files come from the same origin, so a compromised
  # release serves a matching pair. Signing is what would buy authenticity and
  # is deliberately not in this version.
  info "Verifying SHA-256..."
  if ! curl -fsSL --max-time 60 "$sums_url" -o "$STAGING_DIR/$archive.sha256"; then
    rm -rf "$STAGING_DIR"
    fail "Downloaded ${archive} but its checksum file is missing at
      $sums_url
    Refusing to install an unverified binary. Nothing was changed."
  fi

  # `shasum -c` reads "<hash>  <filename>", so it has to run where the file is.
  if ! (cd "$STAGING_DIR" && shasum -a 256 -c "$archive.sha256" >/dev/null 2>&1); then
    local expected actual
    expected="$(awk '{print $1}' "$STAGING_DIR/$archive.sha256" 2>/dev/null || echo '?')"
    actual="$(shasum -a 256 "$STAGING_DIR/$archive" 2>/dev/null | awk '{print $1}' || echo '?')"
    rm -rf "$STAGING_DIR"
    fail "Checksum mismatch for ${archive}.
      expected  $expected
      actual    $actual
    The download was discarded and nothing was installed. Retry; if it happens
    twice, report it rather than working around it."
  fi
  ok "Checksum verified"

  info "Extracting..."
  if ! tar -xzf "$STAGING_DIR/$archive" -C "$STAGING_DIR"; then
    rm -rf "$STAGING_DIR"
    fail "Failed to extract ${archive}."
  fi
  if [ ! -f "$STAGING_DIR/axa" ]; then
    rm -rf "$STAGING_DIR"
    fail "${archive} did not contain an \`axa\` executable. Refusing to guess
    at what else is in it."
  fi
  chmod 755 "$STAGING_DIR/axa"

  # Run it once before anything points at it. The checksum proves these are the
  # published bytes; it proves nothing about whether they start on this machine.
  # Gatekeeper killing the process, a wrong architecture, and a build that was
  # published broken all pass the hash and fail here.
  info "Checking it runs..."
  if ! "$STAGING_DIR/axa" --version >/dev/null 2>"$STAGING_DIR/smoke.err"; then
    local why
    why="$(head -c 500 "$STAGING_DIR/smoke.err" 2>/dev/null || true)"
    rm -rf "$STAGING_DIR"
    fail "The downloaded ${VERSION} binary does not start on this machine.
${why:+      $why
}    It was discarded rather than installed, and nothing that was working
    before has been touched."
  fi
  rm -f "$STAGING_DIR/smoke.err"
}

# Move the staged binary into versions/<version>. rename(2) is atomic and both
# paths are inside DATA_DIR, so either the version is fully there or it is not
# there at all. A process already running an older version keeps its own inode
# and is unaffected by any of this, which is the whole reason the layout is
# shaped this way.
install_version() {
  mkdir -p "$VERSIONS_DIR"
  local target="$VERSIONS_DIR/$VERSION"
  if ! mv -f "$STAGING_DIR/axa" "$target"; then
    rm -rf "$STAGING_DIR"
    fail "Could not move the verified binary into $target."
  fi
  rm -rf "$STAGING_DIR"
  ok "Installed: $target"
}

# -------------------------------------------------------------------
# The launcher
# -------------------------------------------------------------------

# The version the launcher currently points at, or empty if it points anywhere
# else (or nowhere). Used both to record a rollback target and to decide whether
# the launcher is ours to replace.
current_linked_version() {
  [ -L "$LAUNCHER" ] || return 0
  local target
  target="$(readlink "$LAUNCHER" 2>/dev/null || true)"
  case "$target" in
    "$VERSIONS_DIR"/*) basename "$target" ;;
    *) : ;;
  esac
}

# Refuse to overwrite a launcher we did not put there. A regular file or a
# symlink into somewhere else was placed by another tool or by hand, and
# clobbering it is the one mistake in this script the user could not undo with
# this script.
assert_launcher_is_ours() {
  if [ ! -e "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ]; then
    return 0
  fi
  if [ -L "$LAUNCHER" ] && [ -n "$(current_linked_version)" ]; then
    return 0
  fi

  local what
  if [ -L "$LAUNCHER" ]; then
    what="a symlink to $(readlink "$LAUNCHER")"
  elif [ -d "$LAUNCHER" ]; then
    what="a directory"
  else
    what="a regular file"
  fi
  fail "$LAUNCHER already exists and is $what.
    That was not put there by this installer, so it will not be replaced, and
    nothing has been downloaded — this check runs before anything is written.
    Move it aside and run the installer again, or point AXA_BIN_DIR somewhere
    else."
}

# Flip the launcher by renaming a fresh symlink over it. `ln -sfn` unlinks and
# re-links, so there is a window in which `axa` does not exist; rename(2) has no
# such window. The window is short and the cost of closing it is one line.
point_launcher_at() {
  local version="$1"
  mkdir -p "$BIN_DIR"
  local tmp="$BIN_DIR/.axa.$$.tmp"
  rm -f "$tmp"
  ln -s "$VERSIONS_DIR/$version" "$tmp"
  mv -f "$tmp" "$LAUNCHER"
}

# -------------------------------------------------------------------
# Retention
# -------------------------------------------------------------------

# Keep the newest RETAIN versions, and never remove the one the launcher points
# at or the one recorded for rollback — those two are the entire recovery story
# and are not subject to a count. Sorted with `sort -V` so 2.1.9 does not
# outrank 2.1.10.
prune_versions() {
  local active previous
  active="$(current_linked_version)"
  previous="$(cat "$PREVIOUS_FILE" 2>/dev/null || true)"

  local -a all=()
  local entry
  for entry in "$VERSIONS_DIR"/*; do
    [ -f "$entry" ] || continue
    all+=("$(basename "$entry")")
  done
  [ ${#all[@]} -gt "$RETAIN" ] || return 0

  local -a sorted=()
  while IFS= read -r line; do
    [ -n "$line" ] && sorted+=("$line")
  done < <(printf '%s\n' "${all[@]}" | sort -Vr)

  local kept=0 v
  for v in "${sorted[@]}"; do
    if [ "$v" = "$active" ] || [ "$v" = "$previous" ]; then
      continue
    fi
    kept=$((kept + 1))
    # `kept` counts only prunable versions, so the protected two are retained
    # in addition to RETAIN rather than counting against it. With RETAIN=3 that
    # is at most 5 files on disk, and the alternative — counting them — could
    # prune the rollback target the moment a third version arrived.
    #
    # `-gt`, not `-ge`: the RETAIN-th newest is the last one kept.
    if [ "$kept" -gt "$RETAIN" ]; then
      rm -f "$VERSIONS_DIR/$v"
    fi
  done
}

# -------------------------------------------------------------------
# Post-install checks — the ones that stop a silent failure
# -------------------------------------------------------------------

SHADOWED_BY=""
PATH_MISSING=0

check_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
  esac
  PATH_MISSING=1
}

# The failure this function exists for, measured on the author's own machine:
# `axa` was a *zsh function* in ~/.zshrc execing a development checkout, and
# ~/.local/bin/axa did not exist at all. A shell function beats a PATH entry, so
# the install succeeds, the user types `axa`, runs last month's build, and
# reasonably concludes the release is broken. No test that invokes the binary by
# path can see this.
#
# Detection is by reading rc files, not by starting the user's shell: this
# script is frequently run as `curl | bash`, sourcing someone's interactive
# profile has arbitrary side effects, and an rc file that blocks on input would
# hang the installer. Reading is enough to find the case that actually occurs.
check_shadowing() {
  local rc found=""
  for rc in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.zshenv" \
            "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    # A function definition (`axa()` / `function axa`) or an alias. Not a bare
    # mention: rc files legitimately export AXA_* variables and add paths.
    if grep -Eq '^[[:space:]]*(function[[:space:]]+axa\b|axa[[:space:]]*\(\)|alias[[:space:]]+axa=)' "$rc" 2>/dev/null; then
      found="${found}${found:+, }${rc}"
    fi
  done

  # Second, independent signal: whatever this shell would run for `axa` right
  # now. It catches another install earlier on PATH, which the rc scan cannot.
  local resolved
  resolved="$(command -v axa 2>/dev/null || true)"
  if [ -n "$resolved" ] && [ "$resolved" != "$LAUNCHER" ]; then
    found="${found}${found:+, }${resolved}"
  fi

  SHADOWED_BY="$found"
}

# -------------------------------------------------------------------
# Subcommands
# -------------------------------------------------------------------

list_versions() {
  local active
  active="$(current_linked_version)"
  if [ ! -d "$VERSIONS_DIR" ]; then
    echo "No versions installed under $VERSIONS_DIR"
    return 0
  fi
  echo "Installed under $VERSIONS_DIR:"
  local entry name
  # `sort -V`, not the glob's lexical order, which puts 1.0.10 before 1.0.2 and
  # makes the list read as though a version were missing.
  for entry in $(for e in "$VERSIONS_DIR"/*; do [ -f "$e" ] && basename "$e"; done | sort -V); do
    name="$entry"
    if [ "$name" = "$active" ]; then
      printf "  %s  ${GREEN}(active)${RESET}\n" "$name"
    else
      printf "  %s\n" "$name"
    fi
  done
  local previous
  previous="$(cat "$PREVIOUS_FILE" 2>/dev/null || true)"
  [ -n "$previous" ] && echo "Rollback target: $previous"
  return 0
}

rollback() {
  local previous active
  previous="$(cat "$PREVIOUS_FILE" 2>/dev/null || true)"
  active="$(current_linked_version)"

  if [ -z "$previous" ]; then
    fail "There is no recorded previous version to roll back to.
    Pick one yourself:
      $SELF --list-versions
      ln -sfn $VERSIONS_DIR/<version> $LAUNCHER"
  fi
  if [ ! -f "$VERSIONS_DIR/$previous" ]; then
    fail "The recorded previous version ($previous) is no longer on disk.
    Pick another:
      $SELF --list-versions
      ln -sfn $VERSIONS_DIR/<version> $LAUNCHER"
  fi

  assert_launcher_is_ours
  point_launcher_at "$previous"
  # Swap, rather than clear: rolling back twice should return you to where you
  # started instead of stranding you with no target.
  if [ -n "$active" ]; then
    printf '%s\n' "$active" > "$PREVIOUS_FILE"
  else
    rm -f "$PREVIOUS_FILE"
  fi

  ok "Rolled back to $previous${active:+ (from $active)}"
  # A rollback that silently does not take effect is worse than an install that
  # does, because it is run by someone already in trouble. Same two checks.
  VERSION_ACTIVE="$(current_linked_version)"
  check_path
  check_shadowing
  report_launcher_state
  return 0
}

# -------------------------------------------------------------------
# Reporting
# -------------------------------------------------------------------

# Prints the loud half. Called by install and by rollback, because a rollback
# that silently does not take effect is the worse of the two.
report_launcher_state() {
  local clean=1

  if [ "$PATH_MISSING" = "1" ]; then
    clean=0
    echo ""
    warn "$BIN_DIR is not on your PATH"
    printf "${YELLOW}    Add this to your shell profile and open a new terminal:${RESET}\n"
    # %s, not interpolation: BIN_DIR comes from the environment and a `%` in it
    # would otherwise be read as a printf conversion.
    printf "${BOLD}      export PATH=\"%s:\$PATH\"${RESET}\n" "$BIN_DIR"
  fi

  if [ -n "$SHADOWED_BY" ]; then
    clean=0
    echo ""
    printf "${RED}${BOLD}  ACTION REQUIRED — \`axa\` will NOT run what was just installed${RESET}\n"
    echo ""
    printf "  Something else already claims the name \`axa\`:\n"
    printf "${BOLD}    %s${RESET}\n" "$SHADOWED_BY"
    echo ""
    printf "  A shell function or alias beats a PATH entry, so typing \`axa\`\n"
    printf "  will keep running that instead of this install. Point it here:\n"
    echo ""
    printf "${CYAN}    %s${RESET}\n" "$LAUNCHER"
    echo ""
    printf "  If it is a function that also sets environment variables or wraps\n"
    printf "  tmux, keep the function and change only the command it runs — do\n"
    printf "  not delete it.\n"
  fi

  echo ""
  if [ "$clean" = "1" ]; then
    printf "${GREEN}${BOLD}  Done — \`axa\` now runs %s${RESET}\n" "$VERSION_ACTIVE"
  else
    # Neutral between install and rollback: this same line is printed after a
    # rollback, where "installed" would be the wrong word for what just changed.
    printf "${YELLOW}${BOLD}  %s is now the selected version, but \`axa\` will not run it — see above.${RESET}\n" "$VERSION_ACTIVE"
  fi
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------

MODE="install"
REQUESTED_VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rollback) MODE="rollback" ;;
    --list-versions) MODE="list" ;;
    --version) shift; REQUESTED_VERSION="${1:-}"; [ -n "$REQUESTED_VERSION" ] || fail "--version needs a value" ;;
    --version=*) REQUESTED_VERSION="${1#--version=}" ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1
    Run with --help for usage." ;;
  esac
  shift
done

case "$MODE" in
  list)
    list_versions
    exit 0
    ;;
  rollback)
    header
    rollback
    exit 0
    ;;
esac

header
info "Starting installation..."
echo ""

check_platform
check_tools
resolve_version
echo ""

# Checked before anything is downloaded: refusing after a 50 MB transfer and a
# write into versions/ wastes the user's time and leaves state behind.
assert_launcher_is_ours

PREVIOUS_ACTIVE="$(current_linked_version)"

if [ -f "$VERSIONS_DIR/$VERSION" ] && [ "$PREVIOUS_ACTIVE" = "$VERSION" ]; then
  ok "$VERSION is already installed and active"
else
  if [ -f "$VERSIONS_DIR/$VERSION" ]; then
    ok "$VERSION is already downloaded"
  else
    download_and_verify
    install_version
  fi
  point_launcher_at "$VERSION"
  # Recorded only when the launcher actually moved, so that re-running the
  # installer on the version you are already on does not destroy your rollback
  # target by setting it to itself.
  if [ -n "$PREVIOUS_ACTIVE" ] && [ "$PREVIOUS_ACTIVE" != "$VERSION" ]; then
    printf '%s\n' "$PREVIOUS_ACTIVE" > "$PREVIOUS_FILE"
  fi
  ok "Launcher: $LAUNCHER -> $VERSIONS_DIR/$VERSION"
fi

prune_versions
VERSION_ACTIVE="$(current_linked_version)"

check_path
check_shadowing
report_launcher_state

echo ""
printf "  ${BOLD}Run it:${RESET}\n"
printf "    ${CYAN}axa${RESET}                          # interactive REPL\n"
printf "    ${CYAN}axa -p \"your prompt\"${RESET}          # one-shot mode\n"
echo ""
printf "  ${BOLD}Log in:${RESET}\n"
printf "    ${CYAN}axa /login${RESET}                   # or export ANTHROPIC_API_KEY=sk-ant-...\n"
echo ""
printf "  ${BOLD}Later:${RESET}\n"
printf "    ${CYAN}/update${RESET}                      # in-session, no restart needed\n"
printf "    ${CYAN}curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh | bash -s -- --rollback${RESET}\n"
echo ""
printf "  ${DIM}Versions: %s${RESET}\n" "$VERSIONS_DIR"
printf "  ${DIM}Launcher: %s${RESET}\n" "$LAUNCHER"
echo ""
