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

# Shell-safe (backslash-escaped) form of CLAUDE_DIR, for every place below
# where the path is embedded into text that later gets *executed* as a shell
# command line rather than just interpolated into this installer's own
# already-parsed shell (the gui-toggle.md inline `!`...`` body, and the
# statusLine command written into settings.json, which axa/claude spawns
# through a shell). A path with a space or a shell metacharacter — a valid
# CLAUDE_CONFIG_DIR — would otherwise split into extra words or change what
# gets run.
CLAUDE_DIR_Q="$(printf '%q' "$CLAUDE_DIR")"

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

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATE="$CLAUDE_DIR/.gui-state"
LOG="$CLAUDE_DIR/logs/gui.log"
DENY_CONF="$CLAUDE_DIR/.gui-denylist"

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

# Friendly names for the same apps, matched against AppleScript source text —
# `tell application "X"` can target an app without ever making it frontmost,
# so the bundle-id frontmost check above can't be the only guard for `as`.
DEFAULT_DENY_NAMES='1Password
Keychain
Messages
Mail
System Preferences
System Settings
Terminal
iTerm'

denylist() { [ -f "$DENY_CONF" ] && cat "$DENY_CONF" || echo "$DEFAULT_DENY"; }

log() { printf '%s\t%s\tcc=%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "${CLAUDECODE:-0}" "$2" >>"$LOG"; }
die() { echo "gui: $1" >&2; log DENIED "$1"; exit 1; }

# ---------------------------------------------------------------- durata
# The suffix-stripped value is validated as digits-only BEFORE it ever
# reaches arithmetic expansion. `$(( ... ))` evaluates its operand as a new
# round of shell parsing, so an unvalidated value like "$(...)h" would run a
# command substitution while parsing the duration — and `gui toggle` is the
# model-reachable path that supplies this argument (via `gui on "$1"`).
# `10#` forces base-10 so a value with a leading zero (e.g. "08") isn't
# misread as an invalid octal literal.
parse_dur() {
  local raw="$1" val
  case "$raw" in
    *h) val="${raw%h}"
        case "$val" in ''|*[!0-9]*) echo 1800; return ;; esac
        echo $(( 10#$val * 3600 )) ;;
    *m) val="${raw%m}"
        case "$val" in ''|*[!0-9]*) echo 1800; return ;; esac
        echo $(( 10#$val * 60 )) ;;
    *s) val="${raw%s}"
        case "$val" in ''|*[!0-9]*) echo 1800; return ;; esac
        echo $(( 10#$val )) ;;
    ''|*[!0-9]*) echo 1800 ;;
    *) echo $(( 10#$raw * 60 )) ;;
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
  # Absolute path, not bare "gui": $CLAUDE_DIR/bin is only symlinked onto
  # AXA_BIN_DIR (default ~/.local/bin), which this script has no way to know
  # is actually on the user's PATH — the absolute path always works.
  read_state || die "disabilitato. Attivalo tu dal prompt:  !$CLAUDE_DIR/bin/gui on 30m"
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
      echo "gui spento — attiva con:  !$CLAUDE_DIR/bin/gui on 30m"
    fi
    ;;

  badge)
    if read_state; then
      echo "● gui on $(( (EXPIRY - $(date +%s) + 59) / 60 ))m (ctrl+g status)"
    else
      echo "○ gui off (ctrl+g status)"
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

  # AppleScript può bersagliare qualunque app per nome, non solo quella in
  # primo piano, e "do shell script" esce del tutto dal sandboxing di questo
  # wrapper — per questo lo script viene scansionato per nome-app/URL protetti
  # PRIMA di guardare cosa c'è in primo piano, non al posto di quello.
  # guard() (denylist app in primo piano + Secure Input) vale sempre, non solo
  # quando lo script inietta tasti: saltarla per gli script "di sola lettura"
  # apriva un bypass, perché "di sola lettura" non è verificabile dal
  # contenuto dello script.
  as)    require_on
         script="${1:?serve lo script}"
         case "$script" in
           *"do shell script"*) die "AppleScript con 'do shell script' rifiutato — esce dal sandboxing" ;;
         esac
         while IFS= read -r bad; do
           [ -z "$bad" ] && continue
           case "$script" in *"$bad"*) die "lo script punta a un'app protetta ($bad)" ;; esac
         done <<<"$DEFAULT_DENY_NAMES"
         while IFS= read -r bad; do
           [ -z "$bad" ] && continue
           case "$script" in *"$bad"*) die "lo script contiene un URL/servizio protetto ($bad)" ;; esac
         done <<<"$DEFAULT_DENY_URL"
         guard
         case "$script" in
           *keystroke*|*"key code"*) guard_idle ;;
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

# Symlink into the same bin dir install.sh uses for the `axa` launcher, so a
# bare `gui` on the command line resolves the same way `axa` already does —
# a fresh $CLAUDE_DIR/bin has nothing adding it to PATH on its own.
#
# `ln -sf` unconditionally removes whatever is already at the destination —
# including an unrelated user executable or symlink that happens to be named
# `gui`. install.sh guards its own launcher with assert_launcher_is_ours
# before ever touching it; this is the same check adapted for a plain
# convenience symlink (rather than install.sh's versions-dir launcher): only
# replace the target if it doesn't exist yet, or if it's already a symlink
# this installer itself put there on a previous run.
AXA_BIN_DIR_RESOLVED="${AXA_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$AXA_BIN_DIR_RESOLVED"
GUI_LAUNCHER="$AXA_BIN_DIR_RESOLVED/gui"
if [ -e "$GUI_LAUNCHER" ] || [ -L "$GUI_LAUNCHER" ]; then
  if [ -L "$GUI_LAUNCHER" ] && [ "$(readlink "$GUI_LAUNCHER")" = "$CLAUDE_DIR/bin/gui" ]; then
    ok "$GUI_LAUNCHER -> $CLAUDE_DIR/bin/gui (already ours)"
  else
    warn "$GUI_LAUNCHER already exists and was not put there by this installer — leaving it alone.
    Use $CLAUDE_DIR/bin/gui directly (see the activation hints below), or move
    the existing $GUI_LAUNCHER aside and re-run this installer to get the convenience symlink."
  fi
else
  ln -s "$CLAUDE_DIR/bin/gui" "$GUI_LAUNCHER"
  ok "$GUI_LAUNCHER -> $CLAUDE_DIR/bin/gui"
fi

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
badge="$("${CLAUDE_CONFIG_DIR:-$HOME/.claude}/bin/gui" badge 2>/dev/null)"

line="$cwd % $badge"
[ -n "$sid" ] && line="$line · $sid"

printf '%s' "$line"
SL_EOF
chmod +x "$CLAUDE_DIR/bin/statusline"
ok "$CLAUDE_DIR/bin/statusline"

# ---------------------------------------------------------------- gui-toggle command
#
# This command's body does NOT run `gui toggle`/`gui on` itself — it only
# shows status. Verified against src/utils/promptShellExecution.ts: a slash
# command's embedded `!`cmd`` body is executed through the exact same
# hasPermissionsToUseTool() check as a model-issued Bash tool_use — same
# tool, same command string, same permission context. Nothing at that layer
# can tell "the user pressed ctrl+g" apart from "the model chose to run
# this". That distinction matters because of `auto` mode
# (src/utils/permissions/permissions.ts): an otherwise-asking Bash command
# there silently becomes an allow unless isLocallyRiskyAction()
# (src/utils/permissions/localAutoApprove.ts) flags it — and that function
# only flags destructive commands (rm -rf, force-push, DROP TABLE, ...), not
# `gui toggle`. So if this command ran the toggle directly, a user on auto
# mode would get no real gate: the model could reach the identical
# "allowed" outcome on its own, indistinguishable from ctrl+g. Leaving
# `toggle` off the allow list (as before) doesn't close that — "ask" in auto
# mode isn't a real ask, it's a default allow.
#
# `gui toggle`/`gui on` are therefore in the settings.json DENY list below
# (see that section), which — unlike a missing allow rule — does hold in
# auto mode. Because deny applies uniformly regardless of who triggered the
# command, it would equally block this command's own body if it tried to run
# the toggle, so this body sticks to the read-only, allow-listed `gui
# status` and tells the human what to type. A literal `!command` typed
# directly at the prompt (not from inside any command body, slash command or
# otherwise) is the one path in this codebase that bypasses tool-permission
# checks entirely — see src/utils/processUserInput/processBashCommand.tsx,
# which calls BashTool.call() directly with no permission check at all — so
# it is the only mechanism that stays out of the model's reach regardless of
# permission mode. Still deliberately no `allowed-tools` frontmatter, for
# the same reason as before: it would pre-authorize this Bash pattern
# globally rather than leaving `gui status` to axa's normal approval flow.
cat > "$CLAUDE_DIR/commands/gui-toggle.md" <<CMD_EOF
---
description: Mostra lo stato del controllo GUI del Mac (accenderlo/spegnerlo richiede un comando digitato dall'utente, non eseguibile dal modello)
---

!\`${CLAUDE_DIR_Q}/bin/gui status\`

Riporta solo lo stato qui sopra in una riga. Per cambiarlo l'utente deve
digitare lui stesso (non tu, e non da dentro questo comando):
\`!${CLAUDE_DIR_Q}/bin/gui toggle\`
CMD_EOF
ok "$CLAUDE_DIR/commands/gui-toggle.md"

# ---------------------------------------------------------------- keybindings.json (merge)
#
# Only fill ctrl+g in if the key is genuinely absent. `null` is this schema's
# explicit way to unbind a shortcut, and jq's `//=` treats `null` the same as
# "missing" — it would silently overwrite a user's `"ctrl+g": null` unbind
# with our default. `has("ctrl+g")` distinguishes "absent" from "present but
# null", so an explicit unbind is left alone. (setdefault() in the python3
# fallback below does not have this problem: Python's dict.setdefault only
# sets the default when the key is *absent*, not when its value is None, so
# it already preserves an explicit null.)
KB="$CLAUDE_DIR/keybindings.json"
MERGED_KB=0
if command -v jq >/dev/null 2>&1; then
  if [ -f "$KB" ]; then
    tmp="$(mktemp)"
    if jq '
      .bindings |= (
        (map(select(.context == "Chat")) | length) as $n
        | if $n > 0 then
            map(
              if .context == "Chat" then
                .bindings = (
                  (.bindings // {}) as $b
                  | if ($b | has("ctrl+g")) then $b
                    else $b + {"ctrl+g": "command:gui-toggle"}
                    end
                )
              else . end
            )
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
elif command -v python3 >/dev/null 2>&1; then
  if python3 - "$KB" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
bindings = data.setdefault("bindings", [])
chat = next((b for b in bindings if b.get("context") == "Chat"), None)
if chat is None:
    bindings.append({"context": "Chat", "bindings": {"ctrl+g": "command:gui-toggle"}})
else:
    chat.setdefault("bindings", {}).setdefault("ctrl+g", "command:gui-toggle")
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
  then
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
#
# Deliberately NOT a blanket "Bash(gui:*)" allow: that would auto-approve
# `gui on`/`gui toggle` too, and "on" exec'd from inside "toggle" bypasses a
# hypothetical `gui on`-only deny rule entirely (the permission check matches
# the command string the model typed, not what the script does internally).
#
# `on` and `toggle` are BOTH put in `permissions.deny` (not just left out of
# allow). Leaving them merely un-allow-listed is not enough: axa's `auto`
# permission mode (src/utils/permissions/permissions.ts, the fork-local "Auto
# approvals" block) converts an `ask` result straight to `allow` unless
# `isLocallyRiskyAction()` (src/utils/permissions/localAutoApprove.ts) flags
# the command, and that function only flags destructive-shell/PowerShell/
# safetyCheck cases — an unmatched `gui toggle` sails through silently in
# that mode. A `deny` entry is the one thing that beats `auto` mode's
# allow-conversion (deny is checked first and always wins), so it's the only
# installer-side mechanism that actually closes the gap.
#
# Putting `toggle` in deny does mean /gui-toggle itself can no longer *run*
# `gui toggle` for the model — see the gui-toggle.md generation above: that
# command now only shows read-only `gui status` output and tells the human to
# type the real toggle themselves. That's deliberate, not a gap: the one path
# in axa proven to bypass permission checks entirely is a command the user
# *types* at the prompt in bash mode (processBashCommand.tsx calls
# BashTool.call() directly, no hasPermissionsToUseTool() in that path) —
# never something the model can trigger, since the model only ever emits
# tool_use blocks, and even a `command:gui-toggle` keybinding just submits
# `/gui-toggle` through the same permission-checked slash-command path
# (useCommandKeybindings.tsx -> promptShellExecution.ts). So a real,
# human-only gate for the state-changing subcommands is only achievable by
# keeping the model from ever seeing an allow/auto-approve for them, and
# handing the actual toggle back to something only a human can type.
GUI_SAFE_SUBCOMMANDS="frontmost status badge doctor off move click type key as"
GUI_DENY_SUBCOMMANDS="on toggle"

json_array_from_words() {
  # Space-separated bash words -> JSON array of strings, via jq -R/-s so no
  # manual quoting/escaping of the words themselves is needed.
  printf '%s\n' $1 | jq -R . | jq -s .
}
GUI_SAFE_JSON="$(json_array_from_words "$GUI_SAFE_SUBCOMMANDS")"
GUI_DENY_JSON="$(json_array_from_words "$GUI_DENY_SUBCOMMANDS")"

# CLAUDE_CODE_USE_COWORK_PLUGINS truthiness, mirroring isEnvTruthy()
# (src/utils/envUtils.ts): lowercase, match against 1/true/yes/on.
is_env_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:][:blank:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

# Which settings file(s) to merge into. axa's cowork mode
# (getUserSettingsFilePath(), src/utils/settings/settings.ts) resolves to
# cowork_settings.json when either the in-memory --cowork session flag is set
# (never persisted to disk, so a static installer can't see it) or the
# CLAUDE_CODE_USE_COWORK_PLUGINS env var is truthy. We can't observe the
# session flag, but we CAN observe the env var and an already-existing
# cowork_settings.json (itself evidence a previous cowork run created one) —
# so merge into both files whenever either signal is present, and into plain
# settings.json unconditionally. The one irreducible gap: a machine's very
# first --cowork-flag-only run, with no env var set and no prior
# cowork_settings.json on disk, is unobservable from a plain bash installer;
# that run falls back to whatever's already in settings.json.
SETTINGS_TARGETS="$CLAUDE_DIR/settings.json"
if is_env_truthy "${CLAUDE_CODE_USE_COWORK_PLUGINS:-}" || [ -f "$CLAUDE_DIR/cowork_settings.json" ]; then
  SETTINGS_TARGETS="$SETTINGS_TARGETS $CLAUDE_DIR/cowork_settings.json"
fi

# STATUSLINE_CMD is shell-quoted (via CLAUDE_DIR_Q, defined above) because
# statusLine.command is later executed through spawn(..., {shell:true}) —
# unlike the other paths embedded directly into this installer's own
# already-parsed shell, this one becomes a shell command line *again*
# downstream, so it needs its own escaping independent of jq's JSON quoting.
STATUSLINE_CMD="${CLAUDE_DIR_Q}/bin/statusline"

merge_gui_settings() {
  # $1 = target settings file path
  local st="$1" merged=0 tmp
  # Mirror keybindings.json above: a missing file is not a failure, it's a
  # fresh install — merge against "{}" instead of skipping the whole step.
  [ -f "$st" ] || echo '{}' > "$st"
  if command -v jq >/dev/null 2>&1; then
    tmp="$(mktemp)"
    if jq \
      --arg claude_dir "$CLAUDE_DIR" \
      --arg statusline_cmd "$STATUSLINE_CMD" \
      --argjson safe_subs "$GUI_SAFE_JSON" \
      --argjson deny_subs "$GUI_DENY_JSON" \
      '
      def patterns(subs): [subs[] | "Bash(gui \(.):*)", "Bash(\($claude_dir)/bin/gui \(.):*)"];
      .statusLine = (.statusLine // {"type":"command","command":$statusline_cmd})
      | .permissions.allow = ((.permissions.allow // []) + patterns($safe_subs) | unique)
      | .permissions.deny  = ((.permissions.deny  // []) + patterns($deny_subs) | unique)
    ' "$st" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$st"; merged=1
    else
      rm -f "$tmp"
    fi
  elif command -v python3 >/dev/null 2>&1; then
    if CLAUDE_DIR="$CLAUDE_DIR" STATUSLINE_CMD="$STATUSLINE_CMD" \
      GUI_SAFE_JSON="$GUI_SAFE_JSON" GUI_DENY_JSON="$GUI_DENY_JSON" \
      python3 - "$st" <<'PY'
import json, os, sys
path = sys.argv[1]
claude_dir = os.environ["CLAUDE_DIR"]
statusline_cmd = os.environ["STATUSLINE_CMD"]
safe_subs = json.loads(os.environ["GUI_SAFE_JSON"])
deny_subs = json.loads(os.environ["GUI_DENY_JSON"])

def patterns(subs):
    out = []
    for sub in subs:
        out.append(f"Bash(gui {sub}:*)")
        out.append(f"Bash({claude_dir}/bin/gui {sub}:*)")
    return out

with open(path) as f:
    data = json.load(f)
data.setdefault("statusLine", {"type": "command", "command": statusline_cmd})
perms = data.setdefault("permissions", {})
allow = perms.setdefault("allow", [])
deny = perms.setdefault("deny", [])
for entry in patterns(safe_subs):
    if entry not in allow:
        allow.append(entry)
for entry in patterns(deny_subs):
    if entry not in deny:
        deny.append(entry)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
    then
      merged=1
    fi
  fi
  return $((1 - merged))
}

MERGED_ANY=0
MERGED_ALL=1
for st in $SETTINGS_TARGETS; do
  if merge_gui_settings "$st"; then
    ok "$st (statusLine + gui permissions)"
    MERGED_ANY=1
  else
    MERGED_ALL=0
    warn "Could not merge $st automatically (jq/python3 missing or file unreadable)."
  fi
done
if [ "$MERGED_ALL" != "1" ]; then
  echo "    Add this by hand to each file above:"
  echo "      \"statusLine\": { \"type\": \"command\", \"command\": \"$CLAUDE_DIR/bin/statusline\" },"
  echo '      "permissions": {'
  echo "        \"allow\": [\"Bash(gui <sub>:*)\", \"Bash($CLAUDE_DIR/bin/gui <sub>:*)\", ... for each of: $GUI_SAFE_SUBCOMMANDS],"
  echo "        \"deny\":  [\"Bash(gui <sub>:*)\", \"Bash($CLAUDE_DIR/bin/gui <sub>:*)\", ... for each of: $GUI_DENY_SUBCOMMANDS]"
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
# Absolute path here too, for the same reason as the require_on hint above:
# this installer can't know AXA_BIN_DIR is actually on the user's PATH.
echo "gui stays off until you turn it on:  !$CLAUDE_DIR/bin/gui on 30m"
echo "ctrl+g / \`/gui-toggle\` only show status now — turning it on/off must be"
echo "typed by you: !$CLAUDE_DIR/bin/gui toggle   (gui on/toggle are denied for the model)"
