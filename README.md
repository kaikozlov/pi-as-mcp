# pi-as-mcp

Expose pi's core coding tools — **read**, **write**, **edit**, and **bash** — as a Model Context Protocol server over stdio or Streamable HTTP. Optional persistent coding agents are backed by a dedicated Herdr session.

The deployed path in this repository is Streamable HTTP behind **Cloudflare Tunnel + Cloudflare Access**.

## Architecture

```text
ChatGPT
   │
   │ HTTPS / MCP
   ▼
Cloudflare Access + Tunnel
   │
   ▼
pi-as-mcp (Streamable HTTP)
   │
   ├── read / write / edit / bash
   └── persistent agents (optional)
            │
            ▼
          Herdr
```

pi-as-mcp uses the published `@earendil-works/pi-coding-agent` tool implementations directly. The bridge validates MCP arguments, normalizes pi results into MCP content blocks, and optionally exposes Herdr-backed agent lifecycle tools.

## Requirements

- Bun 1.4.4 or newer
- cloudflared
- Herdr, only if persistent agent tools are enabled
- an existing Cloudflare Tunnel configuration, normally at `~/.cloudflared/config.yml`

## Setup

```bash
git clone https://github.com/kaikozlov/pi-as-mcp.git
cd pi-as-mcp
bun run setup
```

`bun run setup` installs dependencies and writes the local deployment configuration to the gitignored `server/.env`. There is no build step; Bun executes the TypeScript source directly.

The Cloudflare Tunnel should route the public MCP hostname to the local HTTP origin, normally `http://127.0.0.1:3333`. Cloudflare Access provides authentication at the edge; pi-as-mcp verifies the injected Access JWT before accepting MCP requests.

## Day-to-day commands

```bash
bun run start
bun run status
bun run logs
bun run restart
bun run stop
```

These commands operate the deployment as one service: the local MCP HTTP server plus cloudflared. The implementation lives in `scripts/service.sh`; package.json does not expose separate implementation-level lifecycle commands.

For development:

```bash
bun run dev
bun run test
```

That is the complete package command surface.

## Configuration

`server/.env` contains the local deployment settings. The template is `server/.env.example`.

Important values:

```bash
PI_MCP_CWD="$HOME/dev"
PI_MCP_TOOLS="read,write,edit,bash,agent"
PI_MCP_BASH_MAX_SYNC_SECONDS="20"
PI_MCP_HERDR_SESSION="pi-as-mcp"

PI_MCP_TRANSPORT="http"
PI_MCP_HTTP_HOST="127.0.0.1"
PI_MCP_HTTP_PORT="3333"
PI_MCP_HTTP_PATH="/mcp"
PI_MCP_HTTP_ALLOWED_HOSTS="mcp.example.com"
PI_MCP_AUTH="cloudflare-access"

CF_ACCESS_TEAM_DOMAIN="https://your-team.cloudflareaccess.com"
CF_ACCESS_AUD="your-access-application-audience"
```

CLI flags override environment defaults.

### Working directory

`PI_MCP_CWD` / `--cwd` controls relative-path resolution. It is **not a sandbox**; pi's tools continue to accept absolute paths.

### Tool selection

Without Herdr configured, the default surface is pi's four core tools. With a Herdr session configured, `agent` enables the persistent agent tool group:

- `list_agents`
- `spawn_agent`
- `send_input`
- `wait_agent`
- `read_agent`
- `send_agent_keys`
- `interrupt_agent`
- `close_agent`

Agent kinds are discovered from the installed Herdr binary. When no explicit default is configured, pi-as-mcp prefers `omp` if installed and otherwise uses the first available integration.

Herdr owns the agent PTYs and workspaces, so an MCP connection or pi-as-mcp process restart does not destroy persistent agents.

### Long-running bash

`PI_MCP_BASH_MAX_SYNC_SECONDS` controls when a long bash invocation is handed off to a durable local job instead of holding one HTTP request open indefinitely.

When the handoff window is exceeded, the tool returns a `session_id`. Poll that session with another `bash` call containing the session ID; use `kill=true` to terminate it. An explicit `timeout` remains a hard command lifetime.

Omit `PI_MCP_BASH_MAX_SYNC_SECONDS` to retain pi's fully synchronous bash behavior.

## Generic stdio use

The server still supports ordinary local stdio MCP clients:

```bash
bun src/index.ts --cwd /path/to/workspace
```

Or configure the client to launch `src/index.ts` with Bun directly.

## Testing

There is one public test command:

```bash
bun run test
```

It performs:

1. TypeScript typechecking with `bun check`
2. shell syntax validation
3. core MCP protocol/tool tests
4. cancellation/process-tree tests
5. managed-bash persistence tests
6. Herdr integration tests
7. Streamable HTTP tests
8. Cloudflare Access authentication tests

The individual test files live under `scripts/test-*.mjs`, but they are implementation details rather than package commands.

## Security

This server provides local code execution by design.

- `read`, `write`, and `edit` accept absolute filesystem paths.
- `bash` executes commands with the permissions of the pi-as-mcp process.
- persistent agents can execute commands and modify files according to their own configuration.
- `--cwd` does not confine filesystem access.

Keep the HTTP origin bound to loopback and expose it through authenticated Cloudflare Access.

MCP tool annotations are advisory client-compatibility metadata, not an authorization boundary.

## Source layout

```text
src/
  index.ts
  tools.ts
  managed-bash.ts
  herdr.ts
  agent-catalog.ts
  agent-tool.ts

scripts/
  setup.sh
  service.sh
  test.sh
  test-core.mjs
  test-cancel.mjs
  test-managed-bash.mjs
  test-herdr.mjs
  test-http.mjs
  test-http-auth.mjs

server/
  .env.example
```

## License

MIT
