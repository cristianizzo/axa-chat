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
#
# Per-process, because the first thing download_and_verify does is `rm -rf` it.
# A fixed path means a second installer — or an in-session `/update` — deletes
# the first one's verified binary in the window between the smoke test and the
# rename, and the first one then fails on a file that passed every check it
# ran. Two runs at once are not a supported workflow, but they are a plausible
# accident, and the failure they produce is unexplainable from the output.
STAGING_DIR="$DATA_DIR/staging/$$"
PREVIOUS_FILE="$DATA_DIR/previous"
LAUNCHER="$BIN_DIR/axa"
RETAIN=3

# Now that staging is per-process, nothing else will ever clean it up. A ctrl-c
# part way through a 173 MB download would otherwise leave that much behind with
# a name nobody recognises. Covers every exit except SIGKILL.
cleanup_staging() { rm -rf "$STAGING_DIR"; }
trap cleanup_staging EXIT INT TERM

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
# A version names a FILE inside versions/, so it is validated before it is ever
# interpolated into a path. Applied to `--version` as well as to the channel
# pointer: the operator typing the flag is trusted, their typo is not, and
# `--version ../../elsewhere/thing` otherwise points the launcher outside
# versions/ at something that was never downloaded and never smoke-tested —
# while printing "already downloaded".
assert_version_shape() {
  local v="$1" origin="$2"
  if [[ ! "$v" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || [[ "$v" == *..* ]]; then
    fail "$origin is not a usable version: \"$v\"
    A version may contain letters, digits, dot, dash and underscore only, and
    must not contain \"..\". Nothing on this machine was changed."
  fi
}

resolve_version() {
  if [ -n "${REQUESTED_VERSION:-}" ]; then
    assert_version_shape "$REQUESTED_VERSION" "--version"
    VERSION="$REQUESTED_VERSION"
    ok "Version: $VERSION (requested)"
    return
  fi

  local url raw status stderr_file
  url="${RELEASE_BASE}/${CHANNEL}/VERSION"
  info "Resolving the latest ${CHANNEL} release..."
  # curl's own diagnosis is kept. "There is no release yet" and "your proxy
  # returned 403" and "DNS does not resolve" are three different problems with
  # three different answers, and collapsing them into one sentence sends the
  # reader to look at the wrong one.
  stderr_file="$(mktemp "${TMPDIR:-/tmp}/axa-resolve.XXXXXX")"
  status=0
  raw="$(curl -fsSL --max-time 60 "$url" 2>"$stderr_file")" || status=$?
  # Strip whitespace/CR rather than trusting the file to be exact: it is
  # produced by CI, and a stray newline would end up in a directory name.
  raw="$(printf '%s' "$raw" | tr -d '[:space:]')"

  if [ "$status" -ne 0 ] || [ -z "$raw" ]; then
    local why
    why="$(head -c 300 "$stderr_file" 2>/dev/null || true)"
    rm -f "$stderr_file"
    fail "Could not read the ${CHANNEL} channel pointer at
      $url
${why:+      $why
}${status:+      curl exited $status
}    Either there is no published release on this channel yet, or the network
    is blocked. Nothing on this machine was changed."
  fi
  rm -f "$stderr_file"
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

# Run a binary once and report whether it starts. Every path that is about to
# make a binary reachable as `axa` goes through here, including the one that
# reuses bytes already on disk: a checksum proves the download, and `[ -f ]`
# proves nothing at all. On failure the first 500 bytes of stderr are left in
# SMOKE_WHY for the caller to quote.
# stdin is closed and the run is bounded. Both matter: the binary is untrusted
# by construction at this point, and a build that reads stdin — or a Gatekeeper
# prompt — would otherwise wedge the installer forever under a line that reads
# like progress ("Checking it runs..."), with nothing to interrupt it. macOS has
# no `timeout(1)`, so the watchdog is a background sleep-and-kill.
SMOKE_WHY=""
SMOKE_TIMEOUT=60
assert_binary_starts() {
  local bin="$1" errfile pid watchdog status=0
  SMOKE_WHY=""
  errfile="$(mktemp "${TMPDIR:-/tmp}/axa-smoke.XXXXXX")"

  "$bin" --version </dev/null >/dev/null 2>"$errfile" &
  pid=$!
  ( sleep "$SMOKE_TIMEOUT"; kill -9 "$pid" 2>/dev/null ) &
  watchdog=$!
  # stderr silenced: when the watchdog fires, bash reports the reaped job as a
  # raw "Killed: 9" line that lands above our own message and reads like a crash
  # in the installer rather than the deliberate timeout it is.
  wait "$pid" 2>/dev/null || status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true

  if [ "$status" -eq 0 ]; then
    rm -f "$errfile"
    return 0
  fi
  SMOKE_WHY="$(head -c 500 "$errfile" 2>/dev/null || true)"
  # 137 = SIGKILL, which here is only ever the watchdog above.
  if [ "$status" -eq 137 ] && [ -z "$SMOKE_WHY" ]; then
    SMOKE_WHY="it did not exit within ${SMOKE_TIMEOUT}s and was killed"
  fi
  rm -f "$errfile"
  return 1
}

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
  if ! assert_binary_starts "$STAGING_DIR/axa"; then
    rm -rf "$STAGING_DIR"
    fail "The downloaded ${VERSION} binary does not start on this machine.
${SMOKE_WHY:+      $SMOKE_WHY
}    It was discarded rather than installed, and nothing that was working
    before has been touched."
  fi
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
# Every step is checked. Unchecked, `set -e` aborts mid-function and the raw
# `ln: Permission denied` from the shell is the entire story the user gets: no
# statement that the launcher was not moved, and — because the abort skips the
# reporting at the end — no statement about which version `axa` still runs. That
# is the worst possible half-state to leave silently, because the version WAS
# installed, so the next run takes the "already downloaded" branch and looks
# even more like a success.
point_launcher_at() {
  local version="$1"
  local still
  still="$(current_linked_version)"
  still="${still:-none — \`axa\` will not run at all}"

  mkdir -p "$BIN_DIR" || fail "Could not create $BIN_DIR.
    $version is installed at $VERSIONS_DIR/$version but nothing points at it.
    Active version: $still"

  local tmp="$BIN_DIR/.axa.$$.tmp"
  rm -f "$tmp"
  if ! ln -s "$VERSIONS_DIR/$version" "$tmp"; then
    rm -f "$tmp"
    fail "Could not create a symlink in $BIN_DIR (check its permissions).
    $version is installed at $VERSIONS_DIR/$version but nothing points at it.
    Active version: $still
    To finish by hand:
      ln -sfn $VERSIONS_DIR/$version $LAUNCHER"
  fi
  # rename(2) over the real name: either the old target or the new one, never
  # a missing launcher.
  if ! mv -f "$tmp" "$LAUNCHER"; then
    rm -f "$tmp"
    fail "Could not replace $LAUNCHER.
    $version is installed at $VERSIONS_DIR/$version but nothing points at it.
    Active version: $still
    To finish by hand:
      ln -sfn $VERSIONS_DIR/$version $LAUNCHER"
  fi
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
SHADOW_DELEGATES=""
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
  local rc found="" delegating=""
  for rc in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.zshenv" \
            "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    # A function definition (`axa()` / `function axa`) or an alias. Not a bare
    # mention: rc files legitimately export AXA_* variables and add paths.
    grep -Eq '^[[:space:]]*(function[[:space:]]+axa\b|axa[[:space:]]*\(\)|alias[[:space:]]+axa=)' "$rc" 2>/dev/null || continue

    # Defining `axa` is not the same as hijacking it. The common case is a
    # wrapper that sets CLAUDE_CONFIG_DIR or starts tmux and *then* runs this
    # very launcher, which is the arrangement this script tells people to build
    # a few lines below — reporting it as "axa will NOT run what was just
    # installed" is a false statement about their machine, and the one that
    # survives is the red block, so it gets believed.
    #
    # Whether the file names $LAUNCHER is a heuristic, not proof: the function
    # could name it in a dead branch. It is chosen because it is wrong in the
    # recoverable direction — a wrapper that really is broken still gets a
    # visible note telling the reader how to check, whereas the reverse mistake
    # sends someone editing a shell config that was already correct.
    #
    # All three spellings, because $LAUNCHER is fully expanded and a shell config
    # almost never is: this repo's own README writes the launcher as
    # `~/.local/bin/axa` in every example, so matching only the absolute path
    # sends exactly the reader who followed the documentation into the red block.
    # The tilde and $HOME forms are only meaningful when the launcher is under
    # $HOME — with AXA_BIN_DIR pointing elsewhere, `${LAUNCHER#$HOME}` is the
    # unchanged absolute path and the extra alternates are harmless duplicates.
    local tail_path="${LAUNCHER#$HOME}"
    if grep -Fq "$LAUNCHER" "$rc" 2>/dev/null ||
       grep -Fq "~${tail_path}" "$rc" 2>/dev/null ||
       grep -Fq "\$HOME${tail_path}" "$rc" 2>/dev/null ||
       grep -Fq "\${HOME}${tail_path}" "$rc" 2>/dev/null; then
      delegating="${delegating}${delegating:+, }${rc}"
    else
      found="${found}${found:+, }${rc}"
    fi
  done
  SHADOW_DELEGATES="$delegating"

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
  # The file is on disk and therefore editable by hand. Same guard as the
  # `--version` flag, for the same reason: it names a path below.
  assert_version_shape "$previous" "$PREVIOUS_FILE"
  if [ ! -f "$VERSIONS_DIR/$previous" ]; then
    fail "The recorded previous version ($previous) is no longer on disk.
    Pick another:
      $SELF --list-versions
      ln -sfn $VERSIONS_DIR/<version> $LAUNCHER"
  fi
  # Refusing before the flip, not after: a rollback onto a binary that does not
  # start leaves the user with neither version working and no obvious way back.
  if ! assert_binary_starts "$VERSIONS_DIR/$previous"; then
    fail "The recorded previous version ($previous) is on disk but does not start.
${SMOKE_WHY:+      $SMOKE_WHY
}    Nothing was changed. Pick another:
      $SELF --list-versions
      ln -sfn $VERSIONS_DIR/<version> $LAUNCHER"
  fi

  assert_launcher_is_ours
  point_launcher_at "$previous"
  # Swap, rather than clear: rolling back twice should return you to where you
  # started instead of stranding you with no target.
  # Same reasoning as the install path, and sharper here: this is run by someone
  # already in trouble, so exiting before the checks below — after the rollback
  # itself succeeded — is the worst possible moment to go quiet.
  if [ -n "$active" ]; then
    printf '%s\n' "$active" > "$PREVIOUS_FILE" || \
      warn "Rolled back, but could not record $active in $PREVIOUS_FILE.
    Rolling back again will not return you to it."
  else
    rm -f "$PREVIOUS_FILE" || true
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

  # Deliberately does not clear `clean`: nothing is known to be wrong here, and
  # this note exists so the reader can confirm rather than be alarmed. It is
  # still printed, because the check behind it is a heuristic and a silent
  # "everything is fine" would be the one outcome they could not check.
  # Suppressed when the red block above also fired. Something IS claiming the
  # name in that case, and printing "nothing needs doing" underneath "axa will
  # NOT run what was just installed" contradicts it — the reader then has to
  # guess which of the two to act on.
  if [ -n "$SHADOW_DELEGATES" ] && [ -z "$SHADOWED_BY" ]; then
    echo ""
    printf "${YELLOW}  \`axa\` is defined in your shell config, and it points here:${RESET}\n"
    printf "${BOLD}    %s${RESET}\n" "$SHADOW_DELEGATES"
    echo ""
    printf "  That is the recommended arrangement — a wrapper that sets variables\n"
    printf "  or starts tmux and then runs this launcher — so nothing needs doing.\n"
    printf "  Confirm with:\n"
    echo ""
    printf "${CYAN}    command -v axa; axa --version${RESET}\n"
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
  # Present on disk is not the same as usable. A run interrupted between the
  # download and the rename, a half-written copy, or a binary that started on
  # the day it was installed and no longer does all satisfy `[ -f ]`. This is
  # the one branch that can point the launcher at bytes nothing ever executed,
  # so it smoke-tests them exactly as the download path does, and discards them
  # and re-downloads rather than adopting them.
  if [ -f "$VERSIONS_DIR/$VERSION" ] && assert_binary_starts "$VERSIONS_DIR/$VERSION"; then
    ok "$VERSION is already downloaded"
  else
    if [ -f "$VERSIONS_DIR/$VERSION" ]; then
      warn "The copy of $VERSION already on disk does not start${SMOKE_WHY:+: $SMOKE_WHY}"
      info "Discarding it and downloading again"
      rm -f "$VERSIONS_DIR/$VERSION"
    fi
    download_and_verify
    install_version
  fi
  point_launcher_at "$VERSION"
  # Recorded only when the launcher actually moved, so that re-running the
  # installer on the version you are already on does not destroy your rollback
  # target by setting it to itself.
  #
  # Failing to record it must not abort the run. The flip has already happened
  # and is not undone by exiting here; what an abort does lose is the PATH and
  # shadowing checks below, which is the loud half the user needs and the whole
  # reason this script prints anything after the install.
  if [ -n "$PREVIOUS_ACTIVE" ] && [ "$PREVIOUS_ACTIVE" != "$VERSION" ]; then
    printf '%s\n' "$PREVIOUS_ACTIVE" > "$PREVIOUS_FILE" || \
      warn "Could not record the rollback target in $PREVIOUS_FILE.
    The install is fine; \`$SELF --rollback\` will not know where to go back to."
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
