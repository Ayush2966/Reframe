#!/usr/bin/env bash
# Runs Reframe in the background whenever you're logged in (a launchd agent),
# restarting it if it ever stops. `./scripts/autostart.sh off` removes it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LABEL="com.reframe.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

case "${1:-on}" in
  on)
    # macOS won't let background apps read Desktop, Documents, Downloads or
    # iCloud Drive without a permission prompt (which comes back after every
    # rebuild), so a launchd agent there just hangs.
    case "$ROOT/" in
      "$HOME/Desktop/"* | "$HOME/Documents/"* | "$HOME/Downloads/"* | "$HOME/Library/Mobile Documents/"*)
        echo "Can't auto-start from $ROOT."
        echo "macOS blocks background apps from your Desktop, Documents and Downloads folders."
        echo "Move the reframe folder somewhere else first, for example:"
        echo "  mv \"$ROOT\" ~/Developer/reframe && cd ~/Developer/reframe && make autostart"
        exit 1
        ;;
    esac
    if [ ! -x bin/reframe ]; then
      echo "Build first: make build"
      exit 1
    fi
    mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/bin/reframe</string>
    <string>-root</string>
    <string>$ROOT</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$ROOT/data/reframe.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/reframe.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Reframe now runs whenever you're logged in: http://localhost:8787"
    echo "Log: $ROOT/data/reframe.log   Turn off: make autostart-off"
    ;;
  off)
    launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Auto-start is off. Start Reframe yourself with: make run"
    ;;
  *)
    echo "Usage: $0 [on|off]"
    exit 1
    ;;
esac
