#!/usr/bin/env bash
set -euo pipefail

# axa-chat installer
# Usage: curl -fsSL https://raw.githubusercontent.com/cristianizzo/axa-chat/main/install.sh | bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

REPO_SLUG="cristianizzo/axa-chat"
REPO="https://github.com/${REPO_SLUG}.git"
BRANCH="main"
INSTALL_DIR="$HOME/axa-chat"
BUN_MIN_VERSION="1.3.11"
# Set by check_git; git is preferred but optional (see fetch_source).
HAS_GIT=0

info()  { printf "${CYAN}[*]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[+]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
fail()  { printf "${RED}[x]${RESET} %s\n" "$*"; exit 1; }

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

# -------------------------------------------------------------------
# System checks
# -------------------------------------------------------------------

check_os() {
  case "$(uname -s)" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *)      fail "Unsupported OS: $(uname -s). macOS or Linux required." ;;
  esac
  ok "OS: $(uname -s) $(uname -m)"
}

# git gives incremental updates and keeps local commits, so it is preferred —
# but it cannot be assumed present (locked-down machines, minimal containers),
# and requiring it would block installation entirely. Without it we fall back to
# source tarballs, which need only curl and tar.
check_git() {
  if command -v git &>/dev/null; then
    HAS_GIT=1
    ok "git: $(git --version | head -1)"
    return
  fi
  warn "git not found — installing from a source tarball instead."
  printf "${DIM}    Updates will re-download tarballs. For incremental updates, install git:${RESET}\n"
  printf "${DIM}      macOS:  xcode-select --install${RESET}\n"
  printf "${DIM}      Linux:  sudo apt install git  (or your distro's equivalent)${RESET}\n"
}

check_curl() {
  command -v curl &>/dev/null || fail "curl is required but not installed."
}

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  [ "$(printf '%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}

check_bun() {
  if command -v bun &>/dev/null; then
    local ver
    ver="$(bun --version 2>/dev/null || echo "0.0.0")"
    if version_gte "$ver" "$BUN_MIN_VERSION"; then
      ok "bun: v${ver}"
      return
    fi
    warn "bun v${ver} found but v${BUN_MIN_VERSION}+ required. Upgrading..."
  else
    info "bun not found. Installing..."
  fi
  install_bun
}

install_bun() {
  curl -fsSL https://bun.sh/install | bash
  # Source the updated profile so bun is on PATH for this session
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    fail "bun installation succeeded but binary not found on PATH.
    Add this to your shell profile and restart:
      export PATH=\"\$HOME/.bun/bin:\$PATH\""
  fi
  ok "bun: v$(bun --version) (just installed)"
}

# -------------------------------------------------------------------
# Clone & build
# -------------------------------------------------------------------

# Record how this tree was installed. $1 is "tarball" or "git", $2 the commit.
#
# For tarball installs this is the only provenance there is: without .git the
# updater and the build's version stamp have nothing else to read a revision
# from, so the shape must match scripts/source.ts.
#
# Git installs write it too, for a different reason: it is the only thing that
# distinguishes an install from a developer's checkout, which is otherwise
# identical on disk. Background auto-update refuses to touch a tree without it,
# so nobody's working copy gets rebased and rebuilt behind their back.
write_install_marker() {
  cat > "$INSTALL_DIR/.axa-install.json" <<EOF
{
  "source": "$1",
  "repo": "${REPO_SLUG}",
  "ref": "${BRANCH}",
  "commit": "$2",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

# Marker for a git install, using the checkout's own HEAD. Skipped rather than
# written with a bogus commit if HEAD cannot be read: the marker is a provenance
# record, and an install that cannot prove its revision should read as absent.
write_git_install_marker() {
  local sha
  sha="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    write_install_marker "git" "$sha"
  fi
}

# True when $1 holds no entries at all, dotfiles included. Written with globs
# rather than `ls -A` so the git-less path stays free of extra tooling: an
# unmatched glob stays literal, and `-e` on a literal is false.
dir_is_empty() {
  local entry
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ -e "$entry" ]; then return 1; fi
  done
  return 0
}

# Whether $1 holds an axa-chat source tree. A package.json alone is far too
# common a thing to find in a directory, so accept either our own marker or a
# pair of files specific to this project.
looks_like_axa_source() {
  if [ -f "$1/.axa-install.json" ]; then return 0; fi
  if [ -f "$1/package.json" ] && [ -f "$1/scripts/build.ts" ] &&
     [ -f "$1/src/entrypoints/cli.tsx" ]; then
    return 0
  fi
  return 1
}

# Download the branch head as a tarball and unpack it over $INSTALL_DIR.
# Resolve the SHA first so the download is pinned to an exact commit and the
# marker records what was actually installed.
fetch_tarball() {
  local sha tmp
  # Checked here rather than up front: a git install never unpacks a tarball,
  # so requiring tar globally would fail installs that do not need it.
  command -v tar &>/dev/null || fail "tar is required to install without git, but is not installed."

  sha="$(curl -fsSL -H 'Accept: application/vnd.github.sha' \
    "https://api.github.com/repos/${REPO_SLUG}/commits/${BRANCH}" 2>/dev/null || true)"
  # Matched with a bash built-in rather than grep, to keep the git-less path
  # dependent on nothing beyond curl and tar.
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    fail "Could not resolve the latest ${BRANCH} commit from GitHub.
    Check your network connection and try again."
  fi

  info "Downloading source tarball (${sha:0:8})..."
  mkdir -p "$INSTALL_DIR"
  # Download to a temp file first so a failed transfer cannot leave a partly
  # extracted source tree behind.
  # Explicit template: portable across GNU and BSD mktemp.
  tmp="$(mktemp "${TMPDIR:-/tmp}/axa-src.XXXXXX")"
  if ! curl -fsSL "https://codeload.github.com/${REPO_SLUG}/tar.gz/${sha}" -o "$tmp"; then
    rm -f "$tmp"
    fail "Failed to download the source tarball."
  fi
  # --strip-components=1 drops GitHub's <repo>-<sha>/ wrapper directory.
  if ! tar -xzf "$tmp" --strip-components=1 -C "$INSTALL_DIR"; then
    rm -f "$tmp"
    fail "Failed to extract the source tarball."
  fi
  rm -f "$tmp"

  write_install_marker "tarball" "$sha"
}

fetch_source() {
  # -f as well as -d: in a linked worktree (and a submodule) .git is a file
  # pointing at the real git dir, and treating one as "not a checkout" would
  # extract a tarball straight over the user's working tree.
  local is_checkout=0
  if [ -d "$INSTALL_DIR/.git" ] || [ -f "$INSTALL_DIR/.git" ]; then is_checkout=1; fi

  # Decided before git is considered, because the tarball branch below is the
  # one that unpacks over whatever is there: a checkout carries the marker (or
  # looks like axa source either way), so without git it would sail past
  # `looks_like_axa_source` and bury the user's branch and uncommitted work.
  # There is nothing useful to do with a checkout without git, so stop.
  if [ "$is_checkout" = "1" ] && [ "$HAS_GIT" != "1" ]; then
    fail "$INSTALL_DIR is a git checkout, but git is not installed.
    Install git and run the installer again, or move the checkout aside first —
    refreshing it from a tarball would overwrite your branch and any local work."
  fi

  if [ "$HAS_GIT" = "1" ] && [ "$is_checkout" = "1" ]; then
    warn "$INSTALL_DIR already exists"
    # Earlier versions of this installer cloned with --depth 1; deepen so
    # ahead/behind comparisons and rebases work on later updates.
    if [ "$(git -C "$INSTALL_DIR" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
      info "Deepening shallow clone..."
      git -C "$INSTALL_DIR" fetch --unshallow 2>/dev/null || warn "Could not fetch full history"
    fi
    info "Pulling latest changes..."
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH" 2>/dev/null || {
      warn "Pull failed, continuing with existing copy"
    }
    write_git_install_marker
  elif [ "$HAS_GIT" = "1" ] && [ ! -d "$INSTALL_DIR" ]; then
    # Full clone, not --depth 1: a shallow repo has no merge base with upstream,
    # which breaks the divergence handling in scripts/update.ts.
    info "Cloning repository..."
    git clone "$REPO" "$INSTALL_DIR"
    write_git_install_marker
  else
    # No git, or a pre-existing directory that is not a checkout.
    if [ -d "$INSTALL_DIR" ] && ! dir_is_empty "$INSTALL_DIR"; then
      # Unpacking over a directory we do not recognise could bury someone
      # else's files, and unlike the git path there is no clone step to refuse
      # first — so require a sign this is an axa-chat tree before writing.
      if ! looks_like_axa_source "$INSTALL_DIR"; then
        fail "$INSTALL_DIR already exists but does not look like an axa-chat install.
    Move or remove it, then run the installer again."
      fi
      warn "$INSTALL_DIR already exists — refreshing it from the tarball"
    fi
    fetch_tarball
  fi
  ok "Source: $INSTALL_DIR"
}

install_deps() {
  info "Installing dependencies..."
  cd "$INSTALL_DIR"
  bun install --frozen-lockfile 2>/dev/null || bun install
  ok "Dependencies installed"
}

build_binary() {
  info "Building axa-chat (all experimental features enabled)..."
  cd "$INSTALL_DIR"
  bun run build:dev:full
  ok "Binary built: $INSTALL_DIR/cli-dev"
}

cleanup() {
  # The compiled binary is standalone — node_modules is only needed to build.
  # Removing it frees ~400MB. `bun run update` (or /update in the CLI) will
  # reinstall it automatically on the next update.
  if [ -d "$INSTALL_DIR/node_modules" ]; then
    info "Removing build-time dependencies (node_modules)..."
    rm -rf "$INSTALL_DIR/node_modules"
    ok "Cleaned up node_modules (binary is standalone)"
  fi
}

link_binary() {
  local link_dir="$HOME/.local/bin"
  mkdir -p "$link_dir"

  ln -sf "$INSTALL_DIR/cli-dev" "$link_dir/axa"
  ok "Symlinked: $link_dir/axa"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$link_dir"; then
    warn "$link_dir is not on your PATH"
    echo ""
    printf "${YELLOW}  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):${RESET}\n"
    printf "${BOLD}    export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}\n"
    echo ""
  fi
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------

header
info "Starting installation..."
echo ""

check_os
check_curl
check_git
check_bun
echo ""

fetch_source
install_deps
build_binary
link_binary
cleanup

echo ""
printf "${GREEN}${BOLD}  Installation complete!${RESET}\n"
echo ""
printf "  ${BOLD}Run it:${RESET}\n"
printf "    ${CYAN}axa${RESET}                          # interactive REPL\n"
printf "    ${CYAN}axa -p \"your prompt\"${RESET}          # one-shot mode\n"
echo ""
printf "  ${BOLD}Set your API key:${RESET}\n"
printf "    ${CYAN}export ANTHROPIC_API_KEY=\"sk-ant-...\"${RESET}\n"
echo ""
printf "  ${BOLD}Or log in with Claude.ai:${RESET}\n"
printf "    ${CYAN}axa /login${RESET}\n"
echo ""
printf "  ${DIM}Source: $INSTALL_DIR${RESET}\n"
printf "  ${DIM}Binary: $INSTALL_DIR/cli-dev${RESET}\n"
printf "  ${DIM}Link:   ~/.local/bin/axa${RESET}\n"
echo ""
