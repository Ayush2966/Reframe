#!/usr/bin/env bash
# Shares Reframe with your own devices over Tailscale: a private HTTPS address
# (https://<this-mac>.<tailnet>.ts.net) that only devices signed in to your
# Tailscale account can open. Reframe itself keeps listening on localhost.
set -euo pipefail
PORT="${PORT:-8787}"

TS="$(command -v tailscale || true)"
if [ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
if [ -z "$TS" ]; then
  echo "Tailscale isn't installed. Get it for this Mac and your phones at https://tailscale.com/download,"
  echo "sign in with the same account everywhere, then run: make phone"
  exit 1
fi
if ! "$TS" status >/dev/null 2>&1; then
  echo "Tailscale isn't running, or this Mac isn't signed in. Open Tailscale, sign in, then run: make phone"
  exit 1
fi
if ! curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  echo "Note: Reframe isn't running on port $PORT yet. Start it with: make run"
fi

# The first time, Tailscale may print a link to enable HTTPS certificates for
# your account. Open it, enable, and this finishes on its own.
"$TS" serve --bg "http://127.0.0.1:$PORT"

NAME="$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
echo
echo "Reframe is shared at: https://$NAME"
echo "Open it on your phone (Tailscale on), then Add to Home Screen / Install app."
echo "To stop sharing: $TS serve --https=443 off"
