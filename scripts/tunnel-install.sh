#!/usr/bin/env bash
# Install an OpenAI tunnel-client build into ./bin.
#
# Stable release mode (default) downloads the pinned archive and verifies the
# published SHA-256 checksum:
#   TUNNEL_CLIENT_VERSION=vX.Y.Z ./scripts/tunnel-install.sh
#
# Commit mode is for a specific upstream fix that has not reached a release yet.
# It checks out the exact official commit and builds it locally with Go:
#   TUNNEL_CLIENT_COMMIT=<40-hex-sha> ./scripts/tunnel-install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${TUNNEL_CLIENT_VERSION:-v0.0.11}"
COMMIT="${TUNNEL_CLIENT_COMMIT:-}"
BASE_URL="https://github.com/openai/tunnel-client/releases/download/${VERSION}"

if [[ -n "$COMMIT" ]]; then
	if [[ -n "${TUNNEL_CLIENT_VERSION:-}" ]]; then
		echo "Set only one of TUNNEL_CLIENT_VERSION or TUNNEL_CLIENT_COMMIT" >&2
		exit 2
	fi
	if [[ ! "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
		echo "TUNNEL_CLIENT_COMMIT must be a full 40-character lowercase git SHA" >&2
		exit 2
	fi
	for command in git go; do
		if ! command -v "$command" >/dev/null 2>&1; then
			echo "Required command not found for commit build: $command" >&2
			exit 1
		fi
	done

	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT
	echo "Building tunnel-client from official commit $COMMIT"
	git clone -q --filter=blob:none --no-checkout https://github.com/openai/tunnel-client.git "$TMP/tunnel-client"
	git -C "$TMP/tunnel-client" fetch -q --depth=1 origin "$COMMIT"
	git -C "$TMP/tunnel-client" checkout -q --detach FETCH_HEAD
	RESOLVED="$(git -C "$TMP/tunnel-client" rev-parse HEAD)"
	if [[ "$RESOLVED" != "$COMMIT" ]]; then
		echo "Resolved commit mismatch" >&2
		echo "expected: $COMMIT" >&2
		echo "actual:   $RESOLVED" >&2
		exit 1
	fi
	(
		cd "$TMP/tunnel-client"
		CGO_ENABLED=0 go build -trimpath \
			-ldflags "-s -w -X github.com/openai/tunnel-client/pkg/version.GitSHA=$COMMIT" \
			-o "$TMP/tunnel-client-bin" ./cmd/client
	)
	mkdir -p bin
	install -m 0755 "$TMP/tunnel-client-bin" bin/tunnel-client
	echo "Installed commit build -> $(pwd)/bin/tunnel-client"
	bin/tunnel-client --version
	exit 0
fi

for command in curl unzip; do
	if ! command -v "$command" >/dev/null 2>&1; then
		echo "Required command not found: $command" >&2
		exit 1
	fi
done

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
	arm64|aarch64) ARCH="arm64" ;;
	x86_64|amd64) ARCH="amd64" ;;
	*) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
case "$OS" in
	darwin|linux) ;;
	*) echo "Unsupported OS: $OS (installer supports macOS and Linux)" >&2; exit 1 ;;
esac

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{print $1}'
	else
		echo "Need sha256sum or shasum to verify tunnel-client" >&2
		return 1
	fi
}

ASSET="tunnel-client-${VERSION}-${OS}-${ARCH}.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading tunnel-client ${VERSION} (${OS}/${ARCH})"
curl -fsSL -o "$TMP/$ASSET" "$BASE_URL/$ASSET"
curl -fsSL -o "$TMP/SHA256SUMS.txt" "$BASE_URL/SHA256SUMS.txt"

EXPECTED="$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$TMP/SHA256SUMS.txt")"
if [ -z "$EXPECTED" ]; then
	echo "No checksum published for $ASSET" >&2
	exit 1
fi
ACTUAL="$(sha256_file "$TMP/$ASSET")"
if [ "$ACTUAL" != "$EXPECTED" ]; then
	echo "Checksum mismatch for $ASSET" >&2
	echo "expected: $EXPECTED" >&2
	echo "actual:   $ACTUAL" >&2
	exit 1
fi

echo "Checksum verified: $ACTUAL"
unzip -q -j "$TMP/$ASSET" tunnel-client -d "$TMP/unpacked"
mkdir -p bin
install -m 0755 "$TMP/unpacked/tunnel-client" bin/tunnel-client

echo "Installed -> $(pwd)/bin/tunnel-client"
bin/tunnel-client --version
