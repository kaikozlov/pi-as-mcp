# pi-as-mcp

Expose [pi](https://github.com/earendil-works/pi)'s four default coding tools — **read**, **write**, **edit**, and **bash** — as a Model Context Protocol server over either **stdio** or **Streamable HTTP**.

The bridge deliberately does not include pi's agent loop. Your MCP client remains the agent; pi-as-mcp supplies pi's actual tool implementations.

## Why

Pi's four-tool interface is enough for most coding workflows:

- `read` — read text files and images
- `write` — create or replace files
- `edit` — exact-text edits
- `bash` — run shell commands

The adapter is intentionally thin. Pi's real tool implementations execute the work; pi-as-mcp only handles MCP schemas, dispatch, cancellation, transport, and authentication.

## Architecture

Local MCP clients can use stdio directly:

```text
MCP client ── stdio ── pi-as-mcp ── pi tools ── local machine
```

Remote clients such as ChatGPT can use standard Streamable HTTP:

```text
ChatGPT / remote MCP client
          │
          │ HTTPS + MCP
          ▼
    reverse proxy / ingress
          │
          │ HTTP to loopback
          ▼
      pi-as-mcp
          │
          ├── read
          ├── write
          ├── edit
          └── bash
```

The canonical remote deployment uses Cloudflare Tunnel for network ingress and Cloudflare Access Managed OAuth for authentication. `cloudflared` remains deliberately MCP-unaware: it forwards HTTP and does not supervise the MCP process.

## Requirements

- [Bun](https://bun.com)
- Node.js **22.19.0 or newer**

## Setup

```bash
git clone https://github.com/kaikozlov/pi-as-mcp.git
cd pi-as-mcp
bun run setup
```

`bun run setup` installs dependencies, builds the server, and creates `server/.env` from `server/.env.example` if needed.

The normal development root is `$HOME/dev`. This is a path-resolution base, **not a sandbox**: absolute paths remain accessible exactly as they are in pi itself.

Run all tests:

```bash
bun run test
```

The suite covers stdio behavior, MCP cancellation/process-tree cleanup, Streamable HTTP discovery/calls, HTTP cancellation followed by a successful call on the same server session, and Cloudflare Access JWT verification (missing token, wrong audience, and valid signed assertion).

## Streamable HTTP

The HTTP server is stateful per MCP session so cancellation notifications reach the same tool execution that owns the in-flight command. Long-running response streams emit SSE keepalives every 15 seconds.

Configuration lives in the gitignored `server/.env`:

```bash
PI_MCP_CWD="$HOME/dev"
# PI_MCP_TOOLS="read,write,edit,bash"
PI_MCP_TRANSPORT="http"
PI_MCP_HTTP_HOST="127.0.0.1"
PI_MCP_HTTP_PORT="3333"
PI_MCP_HTTP_PATH="/mcp"
PI_MCP_HTTP_ALLOWED_HOSTS="mcp.example.com"

PI_MCP_AUTH="cloudflare-access"
CF_ACCESS_TEAM_DOMAIN="https://your-team.cloudflareaccess.com"
CF_ACCESS_AUD="your-access-application-audience-tag"
```

Start it:

```bash
bun run http
```

Check it locally:

```bash
bun run http:status
```

For local-only testing without Cloudflare Access:

```bash
bun run http -- --auth none
```

Unauthenticated HTTP mode refuses to bind to a non-loopback address.

### Cloudflare Access authentication

With `PI_MCP_AUTH=cloudflare-access`, every MCP request must carry Cloudflare's signed `Cf-Access-Jwt-Assertion` header. pi-as-mcp fetches the account's rotating JWKS and verifies:

- JWT signature,
- issuer (`CF_ACCESS_TEAM_DOMAIN`), and
- application audience (`CF_ACCESS_AUD`).

The `/healthz` endpoint is intentionally simple and does not itself perform Access verification; when the hostname is protected by Cloudflare Access, Access still protects it at the edge.

## ChatGPT through Cloudflare

A practical deployment is:

```text
https://mcp.example.com/mcp
        │
        ▼
Cloudflare Access (Managed OAuth)
        │
        ▼
Cloudflare Tunnel
        │
        ▼
http://127.0.0.1:3333/mcp
```

Recommended steps:

1. Install `cloudflared` on the machine running pi-as-mcp.
2. Authenticate `cloudflared` to the Cloudflare account.
3. Create a named tunnel.
4. Route `mcp.example.com` to the tunnel.
5. Configure its origin service as `http://127.0.0.1:3333`.
6. Create a Cloudflare Access application covering the MCP hostname.
7. Restrict its policy to the identity/identities that should receive shell access.
8. Enable **Managed OAuth** and dynamic client registration.
9. Allow the ChatGPT callback URI used by the custom MCP app (for current ChatGPT connectors, an allow-list such as `https://chatgpt.com/connector/oauth/*` is suitable when you intentionally want to permit ChatGPT connector callbacks).
10. Put the Access application's team domain and AUD tag into `server/.env`.
11. Start pi-as-mcp and `cloudflared` as persistent services.
12. Configure the remote MCP endpoint as `https://mcp.example.com/mcp` in the MCP client and select OAuth authentication.

Cloudflare Access performs the interactive OAuth flow. The OAuth access token presented by the client is resolved by Cloudflare at the edge; the origin receives a signed Access JWT and validates it independently.

## CLI

```text
Usage: pi-mcp [options]

-C, --cwd <dir>          Base directory for relative paths
-T, --tools <list>       Comma-separated subset of read,write,edit,bash
    --transport <kind>   stdio or http
    --host <host>        HTTP bind host (default 127.0.0.1)
    --port <port>        HTTP port (default 3333)
    --path <path>        MCP path (default /mcp)
    --auth <kind>        cloudflare-access or none
    --allowed-hosts <l>  Extra HTTP Host allow-list
-V, --version            Print the package version
-h, --help               Show help
```

Environment equivalents are `PI_MCP_CWD`, `PI_MCP_TOOLS`, `PI_MCP_TRANSPORT`, `PI_MCP_HTTP_HOST`, `PI_MCP_HTTP_PORT`, `PI_MCP_HTTP_PATH`, `PI_MCP_HTTP_ALLOWED_HOSTS`, and `PI_MCP_AUTH`.

## Generic stdio MCP client

Build the project and point a local MCP client at `dist/index.js`:

```bash
bun install
bun run build
```

```jsonc
{
  "mcpServers": {
    "pi": {
      "command": "node",
      "args": [
        "/absolute/path/to/pi-as-mcp/dist/index.js",
        "--cwd",
        "/absolute/path/to/dev"
      ]
    }
  }
}
```

## Security

**This server provides local code execution by design.**

Pi's tools are unsandboxed:

- `read`, `write`, and `edit` accept absolute filesystem paths.
- `bash` executes arbitrary shell commands with the permissions of the pi-as-mcp process.
- `--cwd` does not confine access.
- A remote MCP deployment makes those capabilities remotely invokable by an authenticated MCP client.

Treat a write-capable deployment as remote shell access to the account running it. Use a dedicated host/account or narrower tool set if you need stronger isolation. MCP tool annotations are advisory metadata, not an authorization boundary.

For remote HTTP deployment, bind pi-as-mcp to loopback and put authenticated ingress in front of it. Cloudflare Access mode additionally validates the signed Access assertion at the origin.

## Development

```bash
bun run typecheck
bun run build
bun run smoke
bun run smoke:cancel
bun run smoke:http
bun run smoke:http-auth
bun run test
```

Source layout:

```text
src/
  index.ts              CLI, MCP server construction, stdio + HTTP transports
  tools.ts              pi tool factories and MCP annotations
  cloudflare-auth.ts    Cloudflare Access JWT validation
scripts/
  setup.sh              primary server bootstrap
  http.sh               Streamable HTTP operator wrapper
  http-smoke.mjs        HTTP protocol + cancellation regression
  http-auth-smoke.mjs   Cloudflare Access JWT regression
  smoke.mjs             stdio protocol smoke tests
  cancel.mjs            stdio cancellation/process-tree regression
server/
  .env.example          HTTP/Cloudflare configuration template
```

## License

MIT
