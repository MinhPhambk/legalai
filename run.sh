#!/usr/bin/env bash
# Launch opencode fully sandboxed inside this project folder:
# config / data / cache / state / temp / "home" all live under ./.sandbox, so nothing is read from or
# written to the user's real profile. Secrets come from ./.env (QWEN_*, NVIDIA_*).
# Browser: sandbox Chrome (own profile) driven through the chrome MCP (chrome-devtools-mcp --browserUrl).
# Usage: ./run.sh [opencode args...]      e.g.  ./run.sh            (TUI)
#                                                ./run.sh run "câu hỏi"  (non-interactive)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
SB="$ROOT/.sandbox"
mkdir -p "$SB"/{home,config,data,cache,state,tmp,chrome-profile} "$ROOT/workspace"

if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
CHROME_PORT="${CHROME_PORT:-9333}"

# Sandbox Chrome with a local-only DevTools port for the chrome MCP. Started before the HOME/TEMP
# redirection below (Chrome will not open its DevTools port under the redirected profile env); its data
# still lives in .sandbox/chrome-profile.
if ! curl -s -m 2 "http://127.0.0.1:$CHROME_PORT/json/version" >/dev/null; then
  CHROME_PORT="$CHROME_PORT" node "$ROOT/tools/launch-chrome.mjs" > "$SB/tmp/chrome-launcher.log" 2>&1 &
  for _ in $(seq 1 60); do grep -q "ready" "$SB/tmp/chrome-launcher.log" 2>/dev/null && break; sleep 0.5; done
fi
curl -s -m 2 "http://127.0.0.1:$CHROME_PORT/json/version" >/dev/null || { echo "Sandbox Chrome did not open DevTools port $CHROME_PORT – see .sandbox/tmp/chrome-launcher.log" >&2; exit 1; }

export HOME="$SB/home" USERPROFILE="$SB/home"
export XDG_CONFIG_HOME="$SB/config" XDG_DATA_HOME="$SB/data" XDG_CACHE_HOME="$SB/cache" XDG_STATE_HOME="$SB/state"
export TEMP="$SB/tmp" TMP="$SB/tmp" TMPDIR="$SB/tmp"
export OPENCODE_CONFIG="$ROOT/opencode.json" OPENCODE_CONFIG_DIR="$ROOT/.opencode"
export OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_SHARE=1
# Do not pick up Claude Code prompts/skills from parent folders or the real user profile
# (the project is also its own git repo, which stops opencode's upward discovery at this folder).
export OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1 OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1
# Interactive "question" tool (clarifying questions with options) – OPT-IN only: set ND45_QUESTION_TOOL=1
# once the client can answer it (web UI renders question.asked / POST /question/{id}/reply), otherwise a run
# that calls it waits forever. Enables the tool and allows the "question" permission (opencode default: deny)
# for all agents; see docs/QUESTION_TOOL.md.
if [ "${ND45_QUESTION_TOOL:-0}" = 1 ]; then
  export OPENCODE_ENABLE_QUESTION_TOOL=1 OPENCODE_PERMISSION='{"question":"allow"}'
fi
export CHROME_PROFILE_DIR="$SB/chrome-profile" ND45_ROOT="$ROOT" CHROME_PORT
export npm_config_cache="$SB/cache/npm"

cd "$ROOT/workspace"
exec "$ROOT/node_modules/opencode-ai/bin/opencode.exe" "$@"
