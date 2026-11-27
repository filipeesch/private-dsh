#!/bin/bash
# Manage the macOS LaunchAgent that starts the built Web UI at login.
#
# The agent runs this checkout directly, so the commands it issues stay the ones
# the Makefile already names (`make web`); nothing is copied into $HOME except
# the plist itself, and the logs under ~/Library/Logs/dsh-web.
set -euo pipefail

LABEL='com.deepseek.dsh-web-autostart'
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$SCRIPT_DIR/.." && pwd)
SELF="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/dsh-web"
DOMAIN="gui/$(id -u)"
PORT=3080
# Login should not steal focus with a browser tab; a valid session cookie lasts
# 30 days, and the tokenized URL is printed to the log.
WEB_ARGS='--no-open'

usage() {
  echo 'Usage: bash scripts/web-autostart.sh install|uninstall|status|run' >&2
  exit 1
}

require_macos() {
  [[ $(uname -s) = Darwin ]] || { echo 'web-autostart: this target manages a macOS LaunchAgent' >&2; exit 1; }
}

xml_escape() {
  local value=$1
  value=${value//&/&amp;}
  value=${value//</&lt;}
  value=${value//>/&gt;}
  value=${value//\"/&quot;}
  printf '%s' "$value"
}

write_plist() {
  local self_xml repo_xml log_dir_xml
  self_xml=$(xml_escape "$SELF")
  repo_xml=$(xml_escape "$REPO")
  log_dir_xml=$(xml_escape "$LOG_DIR")
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>

	<key>ProgramArguments</key>
	<array>
		<string>$self_xml</string>
		<string>run</string>
	</array>

	<key>WorkingDirectory</key>
	<string>$repo_xml</string>

	<key>RunAtLoad</key>
	<true/>

	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>

	<key>ThrottleInterval</key>
	<integer>60</integer>

	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>

	<key>StandardOutPath</key>
	<string>$log_dir_xml/dsh-web.out.log</string>
	<key>StandardErrorPath</key>
	<string>$log_dir_xml/dsh-web.err.log</string>
</dict>
</plist>
PLIST
}

bootout_quietly() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
}

install_agent() {
  require_macos
  launchctl print "$DOMAIN" >/dev/null || { echo 'web-autostart: log into the macOS desktop as this user first' >&2; exit 1; }
  write_plist
  /usr/bin/plutil -lint "$PLIST" >/dev/null
  bootout_quietly
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "Installed $LABEL: starts \`make web ARGS='$WEB_ARGS'\` at login from $REPO."
  echo "Logs: $LOG_DIR/dsh-web.out.log"
}

uninstall_agent() {
  bootout_quietly
  rm -f "$PLIST"
  echo "Removed $LABEL. The logs in $LOG_DIR are left in place."
}

show_status() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s+(state|pid|program|runs|last exit code) =' || echo "$LABEL is not loaded"
  if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $PORT: listening"
  else
    echo "port $PORT: free"
  fi
}

# LaunchAgent entry point. launchd hands over a minimal environment: no
# ~/.zshrc, no ~/.zprofile, and no nvm, so PATH and the Node toolchain are
# established here instead of being inherited.
run_server() {
  export PATH="$HOME/.local/bin:$HOME/.bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  export NVM_DIR="$HOME/.nvm"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  else
    echo 'web-autostart: nvm is required to resolve node and pnpm' >&2
    exit 1
  fi
  command -v pnpm >/dev/null 2>&1 || { echo 'web-autostart: pnpm is not on PATH after loading nvm' >&2; exit 1; }
  cd "$REPO"
  if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    # Exit 0 on purpose: KeepAlive restarts only failures, and a busy port means
    # a server is already serving, not that this launch broke.
    echo "web-autostart: port $PORT already in use, keeping the running instance"
    exit 0
  fi
  echo "web-autostart: starting $(date '+%Y-%m-%d %H:%M:%S %Z') (node $(node --version), pnpm $(pnpm --version))"
  exec make web ARGS="$WEB_ARGS"
}

[[ $# -ge 1 ]] || usage
case "$1" in
  install) install_agent ;;
  uninstall) uninstall_agent ;;
  status) show_status ;;
  run) run_server ;;
  *) usage ;;
esac
