#!/usr/bin/env bash
set -uo pipefail

# gui-tools installer — optional companion to install.sh
#
#   curl -fsSL https://raw.githubusercontent.com/cristianizzo/axa-chat/main/install-gui-tools.sh | bash
#
# or, in one line together with axa itself:
#
#   curl -fsSL https://raw.githubusercontent.com/cristianizzo/axa-chat/main/install.sh | bash -s -- --with-gui-tools
#
# Installs `gui`: a macOS GUI-automation switch (mouse/keyboard/AppleScript,
# via cliclick) that is INERT until explicitly turned on, plus its companions:
# a statusline badge, a `/gui-toggle` slash command, a ctrl+g keybinding, and
# the permission allow/deny entries that gate it. This is not part of the axa
# binary itself — it is a set of plain files dropped into your config dir, so
# unlike install.sh there is nothing to compile or verify a checksum against;
# what you see below is exactly what gets written.
#
# Safe to re-run: files are overwritten, JSON is merged (not replaced) when
# `jq` or `python3` is available, and it never touches ~/.claude.json (a real
# Claude Code install's session config) or any credentials.

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
info()  { printf "${CYAN}[*]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[+]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
fail()  { printf "${RED}[x]${RESET} %s\n" "$*" >&2; exit 1; }

if [ "$(uname -s)" != "Darwin" ]; then
  fail "gui-tools drives macOS input (cliclick, AppleScript, System Events).
    There is nothing here for $(uname -s)."
fi

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$CLAUDE_DIR/bin" "$CLAUDE_DIR/commands"
info "Installing into $CLAUDE_DIR"

# ---------------------------------------------------------------- gui
cat > "$CLAUDE_DIR/bin/gui" <<'GUI_EOF'
#!/bin/bash
# gui — interruttore + wrapper per il controllo GUI del Mac (mouse, tastiera, AppleScript).
#
# Modello: la capacità è INERTE finché non viene accesa esplicitamente.
# Il TTL è a scorrimento: ogni azione riuscita rimanda la scadenza.
#
#   gui on [30m]   accende (default 30m di inattività)
#   gui off        spegne
#   gui toggle     inverte
#   gui status     stato leggibile
#   gui badge      riga breve per la statusline
#   gui doctor     verifica quali permessi macOS mancano
#
#   gui frontmost              app in primo piano (sempre consentito)
#   gui move X,Y               muove il cursore
#   gui click X,Y              click
#   gui type "testo"           digita
#   gui key return|tab|esc     tasto singolo
#   gui as '<applescript>'     esegue AppleScript

set -uo pipefail

STATE="$HOME/.claude/.gui-state"
LOG="$HOME/.claude/logs/gui.log"
DENY_CONF="$HOME/.claude/.gui-denylist"

mkdir -p "$(dirname "$LOG")"

# ---------------------------------------------------------------- denylist
# App davanti alle quali non si agisce mai. System Settings è nell'elenco
# apposta: impedisce di cliccare attraverso le dialog di permesso TCC.
DEFAULT_DENY='com.apple.keychainaccess
com.1password.1password
com.agilebits.onepassword7
com.apple.MobileSMS
com.apple.mail
com.apple.systempreferences
com.apple.Terminal
com.googlecode.iterm2'

DEFAULT_DENY_URL='bank
paypal
coinbase
binance
kraken.com/u/
metamask'

denylist() { [ -f "$DENY_CONF" ] && cat "$DENY_CONF" || echo "$DEFAULT_DENY"; }

log() { printf '%s\t%s\tcc=%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "${CLAUDECODE:-0}" "$2" >>"$LOG"; }
die() { echo "gui: $1" >&2; log DENIED "$1"; exit 1; }

# ---------------------------------------------------------------- durata
parse_dur() {
  case "$1" in
    *h) echo $(( ${1%h} * 3600 )) ;;
    *m) echo $(( ${1%m} * 60 )) ;;
    *s) echo "${1%s}" ;;
    ''|*[!0-9]*) echo 1800 ;;
    *) echo $(( $1 * 60 )) ;;
  esac
}

read_state() {
  [ -f "$STATE" ] || return 1
  read -r EXPIRY WINDOW <"$STATE" 2>/dev/null || return 1
  [ -n "${EXPIRY:-}" ] || return 1
  [ "$(date +%s)" -lt "$EXPIRY" ] || { rm -f "$STATE"; return 1; }
}

# Ogni azione riuscita sposta avanti la scadenza: è un TTL di inattività.
touch_state() { echo "$(( $(date +%s) + WINDOW )) $WINDOW" >"$STATE"; }

require_on() {
  read_state || die "disabilitato. Attivalo tu dal prompt:  !gui on 30m"
}

# ---------------------------------------------------------------- guardie
frontmost_bundle() {
  osascript -e 'tell application "System Events" to return bundle identifier of first application process whose frontmost is true' 2>/dev/null
}

chrome_url() {
  osascript -e 'tell application "Google Chrome" to return URL of active tab of front window' 2>/dev/null
}

guard() {
  local app url
  app="$(frontmost_bundle)"
  [ -n "$app" ] || die "non riesco a leggere l'app in primo piano (permesso Accessibilità?)"

  while IFS= read -r bad; do
    [ -z "$bad" ] && continue
    [ "$app" = "$bad" ] && die "app protetta in primo piano ($app) — azione rifiutata"
  done <<<"$(denylist)"

  if [ "$app" = "com.google.Chrome" ]; then
    url="$(chrome_url)"
    while IFS= read -r bad; do
      [ -z "$bad" ] && continue
      case "$url" in *"$bad"*) die "URL protetto in primo piano — azione rifiutata" ;; esac
    done <<<"$DEFAULT_DENY_URL"
  fi

  # Secure Input va riletto adesso, non una volta in diagnosi.
  if [ "$(ioreg -l -w 0 2>/dev/null | grep -c kCGSSessionSecureInputPID)" -gt 0 ]; then
    die "Secure Input attivo (campo password a fuoco) — azione rifiutata"
  fi

  FRONT_APP="$app"
}

# Se l'umano ha appena toccato mouse o tastiera, non gli rubo il focus.
guard_idle() {
  local idle_ns idle_s
  idle_ns="$(ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ {print $NF; exit}')"
  [ -n "${idle_ns:-}" ] || return 0
  idle_s=$(( idle_ns / 1000000000 ))
  [ "$idle_s" -lt 3 ] && die "stai usando la macchina (idle ${idle_s}s) — azione rifiutata"
  return 0
}

need() { command -v "$1" >/dev/null || die "manca $1"; }

# ---------------------------------------------------------------- comandi
cmd="${1:-status}"; shift 2>/dev/null || true

case "$cmd" in

  on)
    WINDOW="$(parse_dur "${1:-30m}")"
    touch_state
    log ON "window=${WINDOW}s"
    echo "gui ACCESO — scade dopo $((WINDOW/60)) min di inattività"
    ;;

  off)
    rm -f "$STATE"; log OFF "-"
    echo "gui spento"
    ;;

  toggle)
    if read_state; then exec "$0" off; else exec "$0" on "${1:-30m}"; fi
    ;;

  status)
    if read_state; then
      echo "gui ACCESO — restano $(( (EXPIRY - $(date +%s) + 59) / 60 )) min (finestra $((WINDOW/60))m, si rinnova a ogni uso)"
    else
      echo "gui spento — attiva con:  !gui on 30m"
    fi
    ;;

  badge)
    if read_state; then
      echo "● gui on $(( (EXPIRY - $(date +%s) + 59) / 60 ))m (ctrl+g toggle)"
    else
      echo "○ gui off (ctrl+g toggle)"
    fi
    ;;

  doctor)
    echo "— permessi macOS —"
    if osascript -e 'tell application "System Events" to return name of first process whose frontmost is true' >/dev/null 2>&1
      then echo "  ok    Apple Events / Accessibilità"
      else echo "  MANCA Apple Events — concedi Accessibilità all'app che ospita il terminale"
    fi
    if command -v cliclick >/dev/null && cliclick p >/dev/null 2>&1
      then echo "  ok    eventi CGEvent (cliclick presente)"
      else echo "  MANCA cliclick o il permesso di postare eventi"
    fi
    if screencapture -x /dev/null >/dev/null 2>&1
      then echo "  ok    Registrazione schermo"
      else echo "  MANCA Registrazione schermo (serve per screenshot e titoli finestra)"
    fi
    echo "— contesto —"
    if [ -n "${TMUX:-}" ]
      then tmux_note="SI — attenzione, tmux può spezzare l'attribuzione TCC"
      else tmux_note="no"
    fi
    echo "  TERM_PROGRAM=${TERM_PROGRAM:-?}   tmux=$tmux_note"
    echo "  $("$0" status)"
    ;;

  frontmost)
    frontmost_bundle
    ;;

  # Muovere il cursore non inietta niente: salta la denylist, non la cortesia.
  move)  require_on; guard_idle; need cliclick
         cliclick -w 20 "m:${1:?serve X,Y}" && touch_state && log MOVE "$1" ;;

  click) require_on; guard; guard_idle; need cliclick
         cliclick "c:${1:?serve X,Y}" && touch_state && log CLICK "$1 front=$FRONT_APP" ;;

  type)  require_on; guard; guard_idle; need cliclick
         cliclick ku:cmd,alt,ctrl,shift          # azzera i modificatori rimasti giù
         cliclick "t:${1:?serve il testo}" && touch_state && log TYPE "len=${#1} front=$FRONT_APP" ;;

  key)   require_on; guard; guard_idle; need cliclick
         cliclick "kp:${1:?serve il tasto}" && touch_state && log KEY "$1 front=$FRONT_APP" ;;

  # AppleScript sceglie il bersaglio da sé: qui conta cosa dice lo script,
  # non chi è in primo piano. Tranne quando lo script inietta tasti — allora
  # il bersaglio È il primo piano, e vale la denylist piena.
  as)    require_on
         script="${1:?serve lo script}"
         for bad in 1Password Keychain Messages Mail; do
           case "$script" in *"$bad"*) die "lo script punta a un'app protetta ($bad)" ;; esac
         done
         case "$script" in
           *keystroke*|*"key code"*) guard; guard_idle ;;
           *) FRONT_APP="$(frontmost_bundle)" ;;
         esac
         out="$(osascript -e "$script" 2>&1)"; rc=$?
         [ $rc -eq 0 ] && touch_state
         log AS "rc=$rc front=$FRONT_APP"
         echo "$out"; exit $rc ;;

  *) sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
GUI_EOF
chmod +x "$CLAUDE_DIR/bin/gui"
ok "$CLAUDE_DIR/bin/gui"

# ---------------------------------------------------------------- statusline
cat > "$CLAUDE_DIR/bin/statusline" <<'SL_EOF'
#!/bin/bash
# statusline — rendered by axa/claude below the prompt input.
#
# Receives the status-line JSON payload on stdin. The schema is built by
# buildStatusLineCommandInput() in src/components/StatusLine.tsx, which spreads
# createBaseHookInput() (src/utils/hooks.ts) — that is where `session_id` comes
# from, and it is a non-optional string there.
#
# Output: <cwd> % <gui badge> · <session id>

payload=$(cat)

sid=""
if command -v jq >/dev/null 2>&1; then
  sid=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
fi

cwd="$(pwd | sed "s|^$HOME|~|")"
badge="$($HOME/.claude/bin/gui badge 2>/dev/null)"

line="$cwd % $badge"
[ -n "$sid" ] && line="$line · $sid"

printf '%s' "$line"
SL_EOF
chmod +x "$CLAUDE_DIR/bin/statusline"
ok "$CLAUDE_DIR/bin/statusline"

# ---------------------------------------------------------------- gui-toggle command
cat > "$CLAUDE_DIR/commands/gui-toggle.md" <<CMD_EOF
---
description: Accende/spegne il controllo GUI del Mac (mouse, tastiera, AppleScript)
allowed-tools: Bash($CLAUDE_DIR/bin/gui toggle:*)
---

!\`$CLAUDE_DIR/bin/gui toggle\`

Riporta solo lo stato qui sopra in una riga. Non fare altro.
CMD_EOF
ok "$CLAUDE_DIR/commands/gui-toggle.md"

# ---------------------------------------------------------------- keybindings.json (merge)
KB="$CLAUDE_DIR/keybindings.json"
MERGED_KB=0
if command -v jq >/dev/null 2>&1; then
  if [ -f "$KB" ]; then
    tmp="$(mktemp)"
    if jq '
      .bindings |= (
        (map(select(.context == "Chat")) | length) as $n
        | if $n > 0 then
            map(if .context == "Chat" then .bindings["ctrl+g"] = "command:gui-toggle" else . end)
          else
            . + [{"context":"Chat","bindings":{"ctrl+g":"command:gui-toggle"}}]
          end
      )
    ' "$KB" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$KB"; MERGED_KB=1
    else
      rm -f "$tmp"
    fi
  else
    cat > "$KB" <<'KB_EOF'
{
  "bindings": [
    {
      "context": "Chat",
      "bindings": { "ctrl+g": "command:gui-toggle" }
    }
  ]
}
KB_EOF
    MERGED_KB=1
  fi
fi
if [ "$MERGED_KB" = "1" ]; then
  ok "$KB (ctrl+g -> gui-toggle)"
else
  warn "Could not merge $KB automatically (jq missing or file unreadable)."
  echo "    Add this under \"bindings\" (Chat context) by hand:"
  echo '      "ctrl+g": "command:gui-toggle"'
fi

# ---------------------------------------------------------------- settings.json (merge)
ST="$CLAUDE_DIR/settings.json"
MERGED_ST=0
if command -v jq >/dev/null 2>&1 && [ -f "$ST" ]; then
  tmp="$(mktemp)"
  if jq '
    .statusLine = (.statusLine // {"type":"command","command":"$HOME/.claude/bin/statusline"})
    | .permissions.allow = ((.permissions.allow // []) + ["Bash(gui:*)", "Bash(~/.claude/bin/gui:*)"] | unique)
    | .permissions.deny  = ((.permissions.deny  // []) + ["Bash(gui on:*)", "Bash(~/.claude/bin/gui on:*)"] | unique)
  ' "$ST" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$ST"; MERGED_ST=1
  else
    rm -f "$tmp"
  fi
fi
if [ "$MERGED_ST" = "1" ]; then
  ok "$ST (statusLine + gui permissions)"
else
  warn "Could not merge $ST automatically (jq missing, file missing, or unreadable)."
  echo "    Add this by hand:"
  echo '      "statusLine": { "type": "command", "command": "$HOME/.claude/bin/statusline" },'
  echo '      "permissions": {'
  echo '        "allow": ["Bash(gui:*)", "Bash(~/.claude/bin/gui:*)"],'
  echo '        "deny":  ["Bash(gui on:*)", "Bash(~/.claude/bin/gui on:*)"]'
  echo '      }'
fi

echo ""
printf "${GREEN}Done.${RESET} Still needed on this machine:\n"
echo "  1. brew install cliclick        (required for move/click/type/key)"
echo "  2. Grant Accessibility + Screen Recording to your terminal app"
echo "     (System Settings > Privacy & Security)"
echo "  3. $CLAUDE_DIR/bin/gui doctor    to verify"
echo "  4. Restart axa/claude so the new statusLine + keybinding take effect"
echo ""
echo "gui stays off until you turn it on:  !gui on 30m   (or ctrl+g / \`/gui-toggle\`)"
