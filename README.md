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

- [Bun](https://bun.com) — installs dependencies and runs scripts
- Node.js **22.19.0 or newer** — runs the server (it is the deployed runtime)

## ChatGPT quick start

The only OpenAI-side prerequisites are a Secure MCP Tunnel and a runtime API key. Create those in the OpenAI Platform, and associate the tunnel with the ChatGPT workspace you intend to use.

Then clone the repo and run the setup wizard:

```bash
git clone https://github.com/kaikozlov/pi-as-mcp.git
cd pi-as-mcp
bun run setup
```

`bun run setup`:

1. installs dependencies with bun,
2. builds pi-as-mcp,
3. installs the pinned OpenAI `tunnel-client` and verifies its published SHA-256 checksum,
4. asks for the local development root, tunnel ID, and runtime API key,
5. writes the private local configuration to `tunnel/.env` with mode `0600`.

For a persistent coding workbench, the default development root is `$HOME/dev`. It is usually more useful to expose that broader root than one individual repository, because changing repositories then requires no MCP restart.

Start the tunnel with one command:

```bash
bun run tunnel
```

Startup automatically checks that the build and local configuration are usable, rebuilds stale source if necessary, runs `tunnel-client doctor --explain`, and then starts the tunnel in the foreground. Keep that process running while ChatGPT is using the MCP app; **Ctrl-C stops it**.

In ChatGPT Developer Mode, create a custom app using a **Tunnel** connection and select the associated tunnel.

Useful operator commands:

```bash
bun run tunnel:status   # probe health/readiness and require a successful control-plane poll
bun run tunnel:ui       # open the local tunnel admin UI
bun run tunnel:doctor   # run the full local preflight explicitly
```

That is the normal setup and day-to-day flow.

### Re-running setup

`bun run setup` is idempotent: an existing `tunnel/.env` is loaded and preserved as the default configuration, and the runtime API key is never printed back to the terminal. To force a fresh tunnel-client download:

```bash
bun run setup -- --refresh-tunnel-client
```

For automation or CI-like environments where prompting is undesirable:

```bash
bun run setup -- --non-interactive
```

If no `tunnel/.env` exists in non-interactive mode, the template is installed and must be filled in before the tunnel can start.

## Configuration

The MCP server itself can be run directly:

```text
Usage: pi-mcp [--cwd <dir>] [--tools <list>]

-C, --cwd <dir>       Base directory for relative paths
-T, --tools <list>    Comma-separated subset of read,write,edit,bash
-V, --version         Print the package version
-h, --help            Show help
```

The corresponding environment variables are:

```bash
PI_MCP_CWD="$HOME/dev"
PI_MCP_TOOLS="read,write,edit,bash"
```

CLI flags override environment defaults. `PI_MCP_TOOLS` is optional; omitting it exposes all four tools.

`PI_MCP_CWD` / `--cwd` is a **path-resolution base, not a sandbox**. Relative paths resolve there, but pi's tools continue to accept absolute paths exactly as they do inside pi itself.

The ChatGPT tunnel setup stores these values plus `CONTROL_PLANE_TUNNEL_ID` and `CONTROL_PLANE_API_KEY` in the gitignored `tunnel/.env`. Changing `PI_MCP_CWD` or `PI_MCP_TOOLS` requires restarting the running tunnel because the MCP subprocess receives them when it starts.

## Generic stdio MCP client

If the client can spawn local stdio MCP servers directly, no OpenAI tunnel is needed. Build the project and point the client at `dist/index.js`:

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

To expose only a subset, add for example:

```text
--tools read,bash
```

## Tunnel implementation details

The repo-local tunnel support intentionally keeps OpenAI's tunnel client separate from the MCP bridge:

```text
ChatGPT
   │
   │ OpenAI Secure MCP Tunnel
   ▼
tunnel-client
   │ stdio
   ▼
pi-as-mcp
   │
   └── read / write / edit / bash
```

Relevant files:

```text
scripts/setup.sh             one-command bootstrap/configuration wizard
scripts/tunnel.sh            run/doctor/status/UI operator wrapper
scripts/tunnel-install.sh    checksum-verified tunnel-client installer
tunnel/.env                  private local settings and runtime key (gitignored)
tunnel/profile.yaml          committed tunnel-client profile
bin/tunnel-client            pinned downloaded binary (gitignored)
```

The local tunnel admin UI is configured at `http://127.0.0.1:8080/ui`.

For a stdio MCP target, `doctor` validates local tunnel configuration but does not establish the real long-lived tunnel session. The actual control-plane connection and MCP subprocess lifecycle begin with `run`. If another tunnel-client already owns the configured health port, `doctor` reports that conflict.

The tunnel-client installer defaults to the release pinned in `scripts/tunnel-install.sh`. It can also be invoked directly with another release:

```bash
TUNNEL_CLIENT_VERSION=vX.Y.Z ./scripts/tunnel-install.sh
```

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
bun run typecheck
bun run build
bun run smoke
bun run smoke:cancel
bun run test
```

`bun run test` runs typechecking, a clean build, the protocol smoke suite, and the cancellation test.

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
  setup.sh             interactive local bootstrap/configuration wizard
  smoke.mjs            protocol-level smoke tests
  cancel.mjs           cancellation/process-tree test
  tunnel-install.sh    checksum-verified tunnel-client installer
  tunnel.sh            tunnel run/doctor/status/UI operator wrapper
tunnel/
  .env.example         local configuration template
  profile.yaml         OpenAI Secure MCP Tunnel profile
sandbox/
  ...                  throwaway default tunnel workspace
```

## License

MIT
