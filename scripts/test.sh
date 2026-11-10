#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Tests must not inherit the live deployment's MCP configuration.
unset PI_MCP_CWD PI_MCP_TOOLS PI_MCP_BASH_MAX_SYNC_SECONDS PI_MCP_MAX_AGENTS
unset PI_MCP_DEFAULT_AGENT PI_MCP_HERDR_SESSION PI_MCP_HERDR_BIN
unset PI_MCP_TRANSPORT PI_MCP_HTTP_HOST PI_MCP_HTTP_PORT PI_MCP_HTTP_PATH
unset PI_MCP_HTTP_ALLOWED_HOSTS PI_MCP_AUTH PI_MCP_LOG_FILE
unset CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD

run() {
	local label="$1"
	shift
	printf '\n==> %s\n' "$label"
	"$@"
}

run "Typecheck" bun check
run "Shell syntax" bash -n scripts/setup.sh scripts/service.sh scripts/test.sh
run "Core MCP" bun scripts/test-core.mjs
run "Cancellation" bun scripts/test-cancel.mjs
run "Managed bash" bun scripts/test-managed-bash.mjs
run "Herdr integration" bun scripts/test-herdr.mjs
run "HTTP transport" bun scripts/test-http.mjs
run "Cloudflare Access auth" bun scripts/test-http-auth.mjs
