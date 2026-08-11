#!/usr/bin/env bash
# Bootstrap pi-as-mcp itself. Remote ingress (Cloudflare, reverse proxy, etc.)
# is intentionally separate from the MCP server.
set -euo pipefail
cd "$(dirname "$0")/.."

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=19

usage() {
	cat <<'EOF'
Usage: ./scripts/setup.sh [--non-interactive]

Installs dependencies, builds pi-as-mcp, and creates the local HTTP server
configuration at server/.env when it does not already exist.

Options:
  --non-interactive  Never prompt; use defaults in a newly created server/.env.
  -h, --help         Show this help.

Legacy OpenAI Secure MCP Tunnel setup remains available as:
  bun run setup:tunnel
EOF
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

if [ ! -t 0 ]; then INTERACTIVE=false; fi

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

mkdir -p server
if [ ! -f server/.env ]; then
	install -m 600 server/.env.example server/.env
fi
chmod 600 server/.env

if [ "$INTERACTIVE" = true ]; then
	set -a
	# shellcheck disable=SC1091
	. ./server/.env
	set +a
	DEFAULT_CWD="${PI_MCP_CWD:-${HOME}/dev}"
	printf '\n==> Local HTTP configuration\n'
	printf 'Workspace root [%s]: ' "$DEFAULT_CWD"
	IFS= read -r input
	WORKSPACE="${input:-$DEFAULT_CWD}"
	if [ ! -d "$WORKSPACE" ]; then
		echo "Workspace root does not exist: $WORKSPACE" >&2
		exit 1
	fi
	python3 - "$WORKSPACE" <<'PY'
from pathlib import Path
import shlex, sys
path = Path("server/.env")
workspace = sys.argv[1]
lines = path.read_text().splitlines()
out = []
found = False
for line in lines:
    if line.startswith("PI_MCP_CWD="):
        out.append("PI_MCP_CWD=" + shlex.quote(workspace))
        found = True
    else:
        out.append(line)
if not found:
    out.insert(0, "PI_MCP_CWD=" + shlex.quote(workspace))
path.write_text("\n".join(out) + "\n")
PY
	chmod 600 server/.env
fi

cat <<'EOF'

==> Setup complete

Local HTTP smoke test:
  bun run smoke:http

Run the HTTP MCP server after filling in Cloudflare Access values in server/.env:
  bun run http

For local-only testing without Access:
  bun run http -- --auth none
EOF
