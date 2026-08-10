# pi-as-mcp

Expose [pi](https://github.com/earendil-works/pi)'s four default coding tools — **read**, **write**, **edit**, and **bash** — as a Model Context Protocol server over stdio.

The bridge deliberately does not include pi's agent loop. Your MCP client remains the agent; pi-as-mcp supplies pi's actual tool implementations.

## Why

A capable MCP client does not need a large bespoke coding API. Pi's four-tool interface already provides the useful primitives:

- `read` — read text files and images
- `write` — create or replace files
- `edit` — exact-text edits
- `bash` — run shell commands

That is enough for repository inspection, search, git, builds, tests, formatters, compilers, and essentially any other local development workflow available from the shell.

## How it works

pi-as-mcp depends on the published `@earendil-works/pi-coding-agent` package and creates pi's built-in tool definitions directly:

```text
MCP client
   │
   │ tools/list + tools/call
   ▼
pi-as-mcp
   │
   ├── createReadToolDefinition(cwd)
   ├── createWriteToolDefinition(cwd)
   ├── createEditToolDefinition(cwd)
   └── createBashToolDefinition(cwd)
            │
            ▼
       local machine
```

The adapter is intentionally thin:

- Pi's TypeBox parameter schemas are advertised as MCP JSON Schema and validated before execution.
- Pi's text/image results are normalized into MCP content blocks.
- MCP cancellation is passed into pi's tool execution; for `bash`, pi terminates the spawned process tree.
- Tool errors are returned as MCP tool errors rather than crashing the server.
- MCP annotations describe read-only, destructive, idempotent, and open-world behavior to clients.

There is no tool reimplementation.

## Requirements

- Node.js **22.19.0 or newer**

## Install from source

```bash
git clone https://github.com/kaikozlov/pi-as-mcp.git
cd pi-as-mcp
npm install
npm run build
```

Run the server over stdio:

```bash
npm start
```

or:

```bash
node dist/index.js
```

## Configuration

```text
Usage: pi-mcp [--cwd <dir>] [--tools <list>]

-C, --cwd <dir>       Base directory for relative paths
-T, --tools <list>    Comma-separated subset of read,write,edit,bash
-V, --version         Print the package version
-h, --help            Show help
```

The same defaults can be provided through environment variables:

```bash
export PI_MCP_CWD="$HOME/dev"
export PI_MCP_TOOLS="read,write,edit,bash"
node dist/index.js
```

CLI flags override the corresponding environment defaults.

`PI_MCP_CWD` / `--cwd` is a **path-resolution base, not a sandbox**. Relative paths resolve there, but pi's tools continue to accept absolute paths exactly as they do inside pi itself.

For a persistent coding workbench, using a broader development root is often more useful than binding the server to one repository:

```bash
PI_MCP_CWD="$HOME/dev"
```

Then the client can work across repositories without restarting the MCP server merely to change the base directory.

## Generic stdio MCP client

Point the client at the built server and choose the process working directory or pass `--cwd` explicitly:

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

To expose only read and shell access, for example:

```text
--tools read,bash
```

## ChatGPT via OpenAI Secure MCP Tunnel

ChatGPT cannot directly spawn a stdio MCP server on your laptop. OpenAI's Secure MCP Tunnel runs locally, establishes an outbound connection to OpenAI, and forwards MCP traffic to the stdio server without requiring an inbound port or public MCP endpoint.

This repository includes a small repo-local tunnel setup.

### 1. Build pi-as-mcp

```bash
npm install
npm run build
```

### 2. Create the OpenAI tunnel and runtime key

Create a tunnel in the OpenAI Platform, associate it with the ChatGPT workspace you intend to use, and create a **runtime** API key for the tunnel client.

### 3. Install `tunnel-client`

```bash
./scripts/tunnel-install.sh
```

The installer downloads the pinned OpenAI `tunnel-client` release for macOS/Linux and verifies it against that release's published SHA-256 checksum before installing it to `bin/tunnel-client`.

To deliberately install another release:

```bash
TUNNEL_CLIENT_VERSION=vX.Y.Z ./scripts/tunnel-install.sh
```

### 4. Create the local tunnel environment

```bash
install -m 600 tunnel/.env.example tunnel/.env
$EDITOR tunnel/.env
```

Set at least:

```bash
PI_MCP_CWD="$HOME/dev"
CONTROL_PLANE_TUNNEL_ID=tunnel_...
CONTROL_PLANE_API_KEY=sk_...
```

Optionally restrict the exposed tools:

```bash
PI_MCP_TOOLS=read,bash
```

`tunnel/.env` is gitignored. `scripts/tunnel.sh` also forces it to mode `0600` before loading credentials.

### 5. Validate and run

```bash
./scripts/tunnel.sh doctor --explain
./scripts/tunnel.sh run
```

For a stdio MCP target, `doctor` checks the local configuration, command, credentials presence, and health-listener availability, but it does **not** probe the stdio MCP process or establish the real tunnel session. Those happen when `run` starts the daemon. If another tunnel-client is already running on the configured health port, `doctor` will report that port as busy.

The local tunnel admin UI is configured at:

```text
http://127.0.0.1:8080/ui
```

Leave the daemon running while ChatGPT is using the MCP app. In ChatGPT Developer Mode, create a custom app using a **Tunnel** connection and select the associated tunnel.

Changing `PI_MCP_CWD` or `PI_MCP_TOOLS` requires restarting `tunnel-client` because the MCP subprocess receives those variables when it starts.

## Security

**This server provides local code execution by design.**

Pi's tools are unsandboxed:

- `read`, `write`, and `edit` accept absolute filesystem paths.
- `bash` executes arbitrary shell commands with the permissions of the pi-as-mcp process.
- `--cwd` does not confine access.
- A tunnel makes those capabilities remotely invokable by the connected MCP client.

Treat a write-capable tunnel as remote shell access to the account running it. Do not expose credentials, SSH material, browser profiles, or other sensitive host state unless you intend the MCP client to be able to access them.

For stronger isolation, run pi-as-mcp and the tunnel client inside a dedicated VM, container, or restricted OS account. For inspection-only workflows, expose only `read`; for shell-assisted inspection, `read,bash` is a narrower surface than all four tools.

MCP tool annotations are advisory metadata for clients, not an authorization boundary.

## Development

```bash
npm run typecheck
npm run build
npm run smoke
npm run smoke:cancel
npm test
```

`npm test` runs typechecking, a clean build, the protocol smoke suite, and the cancellation test.

The smoke suite exercises:

- MCP tool discovery and annotations
- text and image reads
- write/edit/bash behavior
- argument validation and tool error paths
- CLI and environment configuration
- tool subsets

The cancellation test starts a long-lived bash command, aborts the MCP request, and verifies that pi kills the process tree rather than leaving it running in the background.

CI runs the suite at the minimum supported Node version and on current Node.

### Source layout

```text
src/
  index.ts             MCP stdio server, CLI/config, validation, dispatch
  tools.ts             pi tool factories and MCP annotations
scripts/
  smoke.mjs            protocol-level smoke tests
  cancel.mjs           cancellation/process-tree test
  tunnel-install.sh    checksum-verified tunnel-client installer
  tunnel.sh            repo-local tunnel-client wrapper
tunnel/
  .env.example         local configuration template
  profile.yaml         OpenAI Secure MCP Tunnel profile
sandbox/
  ...                  throwaway default tunnel workspace
```

## License

MIT
