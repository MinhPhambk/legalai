#!/usr/bin/env bash
# Video/screenshot harness: replay opencode on :4198 + a copy of the web server on :3103 (all data under $HARNESS_DIR – never production data).
set -e
H=${HARNESS_DIR:-/c/Users/Admin/Data/FTU/LegalAI/nd45-platform/.sandbox/demo-harness}   # harness data only
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
mkdir -p $H
# Follow-up suggestions go to the replay server (never to a real model provider).
[ -f $H/opencode.json ] || echo '{ "model": "replay/recorded", "provider": { "replay": { "npm": "@ai-sdk/openai-compatible", "name": "Replay (tự host)", "options": { "baseURL": "{env:FAKE_BASE_URL}", "apiKey": "{env:FAKE_API_KEY}" }, "models": { "recorded": { "name": "Recorded session" } } } } }' > $H/opencode.json
[ -f $H/.env ] || printf 'FAKE_BASE_URL=http://127.0.0.1:4198/v1
FAKE_API_KEY="fake-key"
' > $H/.env
WEB=/c/Users/Admin/Data/FTU/LegalAI/nd45-platform/web
for f in $H/*.pid; do [ -f "$f" ] && { kill "$(cat $f)" 2>/dev/null || true; rm -f "$f"; }; done
sleep 0.5
rm -rf $H/web/server $H/web/client/dist
mkdir -p $H/web/client $H/.sandbox/outputs
cp -r $WEB/server $H/web/server
cp -r ${DIST:-$WEB/client/dist} $H/web/client/dist
cp -r $WEB/scripts $H/web/; cp $WEB/package.json $H/web/package.json
[ -e $H/web/node_modules ] || cp -r $WEB/node_modules $H/web/node_modules
export WEB_DOC_STORE=C:/Users/Admin/Data/FTU/LegalAI/nd45-platform/.opencode/lib/doc-store.ts
export LEGALAI_OUTPUTS_DIR=$(cygpath -w $H/.sandbox/outputs)
export XDG_CACHE_HOME=$(cygpath -w $H/.sandbox/cache)
cd $H
HARNESS_DIR=$(cygpath -m $H) FAKE_OC_PORT=4198 node $SCRIPTS/replay-oc.mjs > $H/replay-oc.log 2>&1 &
echo $! > $H/fake.pid
sleep 1
cd $H/web
PORT=3103 SITE_URL=${SITE_URL:-} OPENCODE_URL=http://127.0.0.1:4198 OPENCODE_SERVER_PASSWORD=x node --disable-warning=ExperimentalWarning server/index.mjs > $H/web.log 2>&1 &
echo $! > $H/web.pid
sleep 2
tail -n 3 $H/replay-oc.log $H/web.log
