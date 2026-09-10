#!/bin/sh
#
# j-time against a pretend JIRA and a pretend GitHub, with its own scratch state.
#
# Nothing here can reach a real board, a real repo or your real ~/.j-time: the
# config points at scripts/mock-jira.mjs and scripts/mock-github.mjs, and JT_HOME
# redirects state.json into a temp directory.
# That matters more than it looks, because filing time posts a worklog the moment
# you pick an activity — "just try it on a real story" creates real worklogs.
#
#   sh scripts/sandbox.sh              # run it
#   sh scripts/sandbox.sh shot.png     # screenshot the palette and exit
#
set -e
cd "$(dirname "$0")/.."

PORT=${MOCK_PORT:-4199}
GH_PORT=${MOCK_GH_PORT:-4198}
SANDBOX=${JT_SANDBOX:-/tmp/j-time-sandbox}
SHOT="$1"

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"

# Plaintext credentials on purpose: readConfig falls back to them when the value
# was never encrypted, which keeps the fixture readable and machine-independent.
cat > "$SANDBOX/config.json" <<JSON
{
  "shell": { "hotkey": "Command+Shift+J" },
  "layout": { "order": ["jira", "github"], "collapsed": [], "pinsOff": [] },
  "plugins": {
    "jira": {
      "baseUrl": "http://localhost:$PORT",
      "email": "dana@example.test",
      "apiToken": "sandbox-token",
      "activities": ["Meeting", "Building", "Testing", "Review", "Other"],
      "roundMinutes": 5,
      "boardId": null,
      "mineOnly": true
    },
    "github": {
      "host": "http://localhost:$GH_PORT",
      "token": "sandbox-token",
      "limit": 25
    }
  }
}
JSON

# A clock already running on one story and filed time on another, so the palette
# has something to show without anyone having to sit and press keys.
NOW=$(node -e 'process.stdout.write(String(Date.now()))')
node -e '
  const now = Number(process.argv[1]);
  const state = {
    activeKey: "SAND-102",
    stories: {
      "SAND-102": {
        key: "SAND-102", summary: "Rework the checkout form validation",
        status: "In Progress", assignee: "Dana Ruiz", estimateSeconds: 21600,
        segments: [
          { start: now - 5400e3, end: now - 3600e3, activity: "Building", logged: true },
          { start: now - 1500e3, end: now - 900e3, activity: null },
          { start: now - 754e3, end: null },
        ],
        doneAt: null, worklogId: "9001", loggedSeconds: 1800,
      },
      "SAND-103": {
        key: "SAND-103", summary: "Cache the pricing table lookup",
        status: "In Progress", assignee: "Dana Ruiz", estimateSeconds: 10800,
        segments: [{ start: now - 86400e3, end: now - 84600e3, activity: "Review" }],
        doneAt: null, worklogId: null, loggedSeconds: null,
      },
    },
  };
  require("fs").writeFileSync(process.argv[2], JSON.stringify(state, null, 2));
' "$NOW" "$SANDBOX/state.json"

node scripts/mock-jira.mjs "$PORT" &
MOCK=$!
node scripts/mock-github.mjs "$GH_PORT" &
MOCK_GH=$!
trap 'kill $MOCK $MOCK_GH 2>/dev/null' EXIT INT TERM
sleep 1

npx electron-vite build >/dev/null
if [ -n "$SHOT" ]; then
  JT_HOME="$SANDBOX" JT_CAPTURE="$(cd "$(dirname "$SHOT")" && pwd)/$(basename "$SHOT")" \
    ./node_modules/.bin/electron .
  echo "wrote $SHOT"
else
  JT_HOME="$SANDBOX" ./node_modules/.bin/electron .
fi
