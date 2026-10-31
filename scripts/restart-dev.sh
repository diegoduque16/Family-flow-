#!/bin/sh
# restart the local dev server with a fresh database
[ -f /tmp/ff-dev.pid ] && kill "$(cat /tmp/ff-dev.pid)" 2>/dev/null
for p in $(pgrep -f "node scripts/dev-server"); do kill "$p" 2>/dev/null; done
rm -f /tmp/ff-e2e.sqlite
MOCK_AI=1 MOCK_PLACES=1 nohup node scripts/dev-server.js 8787 /tmp/ff-e2e.sqlite > /tmp/dev.log 2>&1 &
echo $! > /tmp/ff-dev.pid
sleep 1.5
