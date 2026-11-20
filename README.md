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

The Cloudflare Tunnel should route the public MCP hostname to the local HTTP origin, normally `http://127.0.0.1:3333`. Cloudflare Access authenticates at the edge; pi-as-mcp verifies the injected Access JWT, but does not provide MCP OAuth discovery or Protected Resource Metadata.

## Day-to-day commands

```bash
bun run start
bun run status
bun run logs
bun run restart
bun run stop
```

For development:

```bash
bun run dev
bun check
bun test
```

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

If the command runs past the handoff window, `bash` returns a `session_id`. Poll the job with only `session_id`. To terminate the job, send `session_id` with `kill: true`. The optional `timeout` sets the maximum command lifetime.

Omit `PI_MCP_BASH_MAX_SYNC_SECONDS` to retain pi's fully synchronous bash behavior.

## Generic stdio use

```bash
bun src/index.ts --cwd /path/to/workspace
```

Or configure the client to launch `src/index.ts` with Bun directly.

## Testing

```bash
bun check
bun test
```

## License

MIT
