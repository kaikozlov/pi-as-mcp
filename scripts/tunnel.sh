#!/usr/bin/env bash
# Self-contained tunnel-client runner. Sources tunnel/.env (gitignored) for
# CONTROL_PLANE_TUNNEL_ID + CONTROL_PLANE_API_KEY and points at the repo-local
# profile. Runnable from any directory.
#
#   ./scripts/tunnel.sh doctor --explain   # validate auth + MCP handshake
#   ./scripts/tunnel.sh run                # start the daemon (leave running)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x bin/tunnel-client ]; then
	echo "bin/tunnel-client missing. Run: ./scripts/tunnel-install.sh" >&2
	exit 1
fi
if [ ! -f tunnel/.env ]; then
	echo "tunnel/.env missing. Copy tunnel/.env.example to tunnel/.env and fill in." >&2
	exit 1
fi

# dotenv: export KEY=VALUE pairs (values here have no shell metacharacters).
set -a; . ./tunnel/.env; set +a

# Only run/doctor need the profile; pass other subcommands (help, version) through.
case "${1:-}" in
	run|doctor) exec ./bin/tunnel-client "$@" --profile-file ./tunnel/profile.yaml ;;
	*)          exec ./bin/tunnel-client "$@" ;;
esac
