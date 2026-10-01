#!/usr/bin/env bash
# Fresh harness state for the video: stop, wipe harness data (only under v6/h), start, create the demo user, seed.
set -e
H=${HARNESS_DIR:-/c/Users/Admin/Data/FTU/LegalAI/nd45-platform/.sandbox/demo-harness}   # harness data only
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
for f in $H/*.pid; do [ -f "$f" ] && { kill "$(cat $f)" 2>/dev/null || true; rm -f "$f"; }; done
sleep 1
rm -rf $H/.sandbox $H/sessions.json
$SCRIPTS/harness-start.sh > /dev/null 2>&1
cd $H/web && node --disable-warning=ExperimentalWarning scripts/create-user.mjs demo@legalai.local 'Demo-Pass-2026!' --admin > /dev/null
cd $H && HARNESS_DIR=$(cygpath -m $H) ONLY=${ONLY:-trade,precedent,edit,coffee} node $SCRIPTS/seed.mjs > seeded.json
cat seeded.json
