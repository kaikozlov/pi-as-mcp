#!/usr/bin/env bash
# Small operator wrapper around the repo-local OpenAI tunnel-client.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="./tunnel/profile.yaml"
ENV_FILE="./tunnel/.env"
CLIENT="./bin/tunnel-client"
HEALTH_PORT=8080

usage() {
	cat <<'EOF'
Usage: ./scripts/tunnel.sh <command> [args...]

Commands:
  run       Validate local configuration, then run the tunnel in the foreground
  doctor    Run tunnel-client doctor --explain
  status    Probe the live tunnel and require a successful control-plane poll
  ui        Open the local tunnel admin UI
  client    Pass remaining arguments directly to tunnel-client
  help      Show this help

Common bun aliases:
  bun run tunnel
  bun run tunnel:doctor
  bun run tunnel:status
  bun run tunnel:ui

First-time setup:
  bun run setup
EOF
}

fail_setup() {
	echo "$1" >&2
	echo "Run: bun run setup" >&2
	exit 1
}

ensure_client() {
	[ -x "$CLIENT" ] || fail_setup "OpenAI tunnel-client is not installed."
}

warn_known_bad_client() {
	local version
	version="$($CLIENT --version 2>/dev/null || true)"
	case "$version" in
		0.0.11*)
			echo "WARNING: tunnel-client v0.0.11 has an upstream shared-stdio response-deadline shutdown bug (openai/tunnel-client#34)." >&2
			echo "Install the fixed upstream commit or a later stable release before relying on long-running tool calls." >&2
			;;
	esac
}

load_env() {
	[ -f "$ENV_FILE" ] || fail_setup "tunnel/.env is missing."
	chmod 600 "$ENV_FILE"
	set -a
	# shellcheck disable=SC1091
	. "$ENV_FILE"
	set +a

	case "${CONTROL_PLANE_TUNNEL_ID:-}" in
		""|tunnel_paste_your_tunnel_id_here) fail_setup "CONTROL_PLANE_TUNNEL_ID is not configured." ;;
	esac
	case "${CONTROL_PLANE_API_KEY:-}" in
		""|sk_paste_your_runtime_key_here) fail_setup "CONTROL_PLANE_API_KEY is not configured." ;;
	esac
}

needs_build() {
	if [ ! -f dist/index.js ]; then
		return 0
	fi
	for path in package.json tsconfig.json src/*.ts; do
		if [ "$path" -nt dist/index.js ]; then
			return 0
		fi
	done
	return 1
}

ensure_build() {
	if needs_build; then
		echo "pi-as-mcp build is missing or stale; rebuilding..." >&2
		bun run build >&2
	fi
}

run_doctor() {
	ensure_client
	load_env
	ensure_build
	"$CLIENT" doctor "$@" --profile-file "$PROFILE"
}

command="${1:-help}"
if [ "$#" -gt 0 ]; then shift; fi

case "$command" in
	run|start)
		ensure_client
		warn_known_bad_client
		load_env
		ensure_build
		echo "Running tunnel preflight..." >&2
		"$CLIENT" doctor --explain --profile-file "$PROFILE" >&2
		echo "Starting tunnel. Keep this process running; Ctrl-C stops it." >&2
		exec "$CLIENT" run --profile-file "$PROFILE" "$@"
		;;
	doctor)
		ensure_client
		warn_known_bad_client
		if [ "$#" -eq 0 ]; then
			set -- --explain
		fi
		run_doctor "$@"
		;;
	status)
		ensure_client
		exec "$CLIENT" health --port "$HEALTH_PORT" --require-control-plane-poll "$@"
		;;
	ui)
		url="http://127.0.0.1:${HEALTH_PORT}/ui"
		if command -v open >/dev/null 2>&1; then
			open "$url"
		elif command -v xdg-open >/dev/null 2>&1; then
			xdg-open "$url" >/dev/null 2>&1 &
		else
			echo "$url"
		fi
		;;
	client)
		ensure_client
		exec "$CLIENT" "$@"
		;;
	help|-h|--help)
		usage
		;;
	*)
		echo "Unknown tunnel command: $command" >&2
		usage >&2
		exit 2
		;;
esac
