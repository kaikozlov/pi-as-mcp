#!/usr/bin/env bash
# Bootstrap the direct Streamable HTTP / Cloudflare Access deployment without
# modifying the independent OpenAI Secure MCP Tunnel configuration.
set -euo pipefail
cd "$(dirname "$0")/.."

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=19
ENV_FILE="server/.env"

usage() {
	cat <<'USAGE'
Usage: ./scripts/setup-http.sh [--non-interactive]

Installs dependencies, builds pi-as-mcp, and creates/updates the direct HTTP
configuration at server/.env. This does not modify tunnel/.env or the OpenAI
Secure MCP Tunnel deployment.

Options:
  --non-interactive  Never prompt; create server/.env from the template if absent.
  -h, --help         Show this help.
USAGE
}

INTERACTIVE=true
while [ "$#" -gt 0 ]; do
	case "$1" in
		--non-interactive) INTERACTIVE=false ;;
		-h|--help) usage; exit 0 ;;
		*) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
	esac
	shift
done
[ -t 0 ] || INTERACTIVE=false

if ! command -v node >/dev/null 2>&1; then
	echo "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required." >&2
	exit 1
fi
if ! node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
'; then
	echo "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required; found $(node --version)." >&2
	exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
	echo "Bun is required to install dependencies and run scripts." >&2
	exit 1
fi

printf '\n==> Installing dependencies\n'
bun install
printf '\n==> Building pi-as-mcp\n'
bun run build

mkdir -p server logs
if [ ! -f "$ENV_FILE" ]; then
	install -m 600 server/.env.example "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

if [ "$INTERACTIVE" = true ]; then
	set -a
	# shellcheck disable=SC1091
	. "./$ENV_FILE"
	set +a

	DEFAULT_CWD="${PI_MCP_CWD:-${HOME}/dev}"
	DEFAULT_HOSTS="${PI_MCP_HTTP_ALLOWED_HOSTS:-}"
	DEFAULT_TEAM="${CF_ACCESS_TEAM_DOMAIN:-}"
	DEFAULT_AUD="${CF_ACCESS_AUD:-}"

	printf '\n==> Direct HTTP configuration\n'
	printf 'Workspace root [%s]: ' "$DEFAULT_CWD"
	IFS= read -r input
	WORKSPACE="${input:-$DEFAULT_CWD}"
	[ -d "$WORKSPACE" ] || { echo "Workspace root does not exist: $WORKSPACE" >&2; exit 1; }

	printf 'Public MCP hostname [%s]: ' "${DEFAULT_HOSTS:-mcp.example.com}"
	IFS= read -r input
	HOSTS="${input:-${DEFAULT_HOSTS:-mcp.example.com}}"

	printf 'Cloudflare Access team domain [%s]: ' "${DEFAULT_TEAM:-https://your-team.cloudflareaccess.com}"
	IFS= read -r input
	TEAM="${input:-${DEFAULT_TEAM:-https://your-team.cloudflareaccess.com}}"

	printf 'Cloudflare Access audience tag [%s]: ' "${DEFAULT_AUD:+configured; Enter to keep}"
	IFS= read -r input
	AUD="${input:-$DEFAULT_AUD}"

	python3 - "$ENV_FILE" "$WORKSPACE" "$HOSTS" "$TEAM" "$AUD" "$(pwd)/logs/http-lifecycle.jsonl" <<'PY'
from pathlib import Path
import shlex, sys
path, workspace, hosts, team, aud, logfile = sys.argv[1:]
p = Path(path)
updates = {
    "PI_MCP_CWD": workspace,
    "PI_MCP_HTTP_ALLOWED_HOSTS": hosts,
    "CF_ACCESS_TEAM_DOMAIN": team,
    "CF_ACCESS_AUD": aud,
    "PI_MCP_LOG_FILE": logfile,
}
lines = p.read_text().splitlines()
out = []
seen = set()
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        key = line.split("=", 1)[0].strip()
        if key in updates:
            out.append(f"{key}={shlex.quote(updates[key])}")
            seen.add(key)
            continue
    out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={shlex.quote(value)}")
p.write_text("\n".join(out) + "\n")
PY
	chmod 600 "$ENV_FILE"
fi

cat <<'DONE'

==> Direct HTTP setup complete

Validate locally:
  bun run smoke:http
  bun run smoke:http-auth

Start the direct path:
  bun run http:start
  bun run cloudflare:start

Inspect it:
  bun run http:status
  bun run cloudflare:status
DONE
