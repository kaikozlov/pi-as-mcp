# pi-as-mcp

Expose [pi](https://github.com/earendil-works/pi)'s four default coding tools — **read**, **write**, **edit**, and **bash** — as a Model Context Protocol server over stdio or Streamable HTTP. Optionally add one **agent** tool backed by a dedicated persistent [Herdr](https://github.com/herdrdev/herdr) session.

The bridge deliberately does not include pi's agent loop. Your MCP client remains the agent; pi-as-mcp supplies pi's actual tool implementations, while Herdr can provide a separate runtime for persistent interactive coding agents.

## Why

A capable MCP client does not need a large bespoke coding API. Pi's four-tool interface already provides the useful primitives:

- `read` — read text files and images
- `write` — create or replace files
- `edit` — exact-text edits
- `bash` — run shell commands

That is enough for repository inspection, search, git, builds, tests, formatters, compilers, and essentially any other local development workflow available from the shell.

When Herdr integration is enabled, `agent` adds a deliberately separate primitive for long-lived interactive coding agents. Ordinary commands still use `bash`; Herdr is not used as a hidden replacement for shell execution.

## How it works

pi-as-mcp depends on the published `@earendil-works/pi-coding-agent` package and creates pi's built-in tool definitions directly:

```text
MCP client
   │
   │ stdio or Streamable HTTP
   │ tools/list + tools/call
   ▼
pi-as-mcp
   │
   ├── createReadToolDefinition(cwd)
   ├── createWriteToolDefinition(cwd)
   ├── createEditToolDefinition(cwd)
   ├── createBashToolDefinition(cwd)
   │        │
   │        ▼
   │   local machine
   │
   └── agent (optional)
            │
            ▼
      named Herdr session
```

The adapter is intentionally thin:

- Pi's TypeBox parameter schemas are advertised as MCP JSON Schema and validated before execution.
- Pi's text/image results are normalized into MCP content blocks.
- MCP cancellation is passed into pi's tool execution; for `bash`, pi terminates the spawned process tree.
- When configured, `agent` targets only pi-as-mcp's explicit named Herdr session; inherited Herdr pane/session/socket context is stripped.
- Tool errors are returned as MCP tool errors rather than crashing the server.
- MCP annotations are compatibility metadata for clients. The current profile intentionally advertises every exposed tool as read-only, idempotent, and closed-world because ChatGPT mobile otherwise refuses to expose the connector; these hints are advisory and do not restrict actual write/edit/bash/agent behavior.

There is no tool reimplementation.

## Requirements

- [Bun](https://bun.com) — installs dependencies and runs scripts
- Node.js **22.19.0 or newer** — runs the server (it is the deployed runtime)
- [Herdr](https://github.com/herdrdev/herdr) — optional; required only when the `agent` tool is enabled

## ChatGPT quick start

For the OpenAI Secure MCP Tunnel path, create a Secure MCP Tunnel and runtime API key in the OpenAI Platform, then associate the tunnel with the ChatGPT workspace you intend to use. A direct Streamable HTTP + Cloudflare Access path is documented below and does not use OpenAI tunnel-client.

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
5. when Herdr is already installed, defaults the optional agent runtime to the dedicated `pi-as-mcp` named session,
6. writes the private local configuration to `tunnel/.env` with mode `0600`.

For a persistent coding workbench, the default development root is `$HOME/dev`. It is usually more useful to expose that broader root than one individual repository, because changing repositories then requires no MCP restart.

Start the tunnel with one command:

```bash
bun run tunnel
```

When `PI_MCP_HERDR_SESSION` is configured, that command ensures a reserved `runtime` workspace exists in the dedicated Herdr session, starts the real tunnel process in its persistent root pane if necessary, and then opens the **full named Herdr session UI** for that dedicated session. Detach with **Ctrl-B q** and the tunnel keeps running. Running `bun run tunnel` again from a normal host/SSH shell reconnects to the same `pi-as-mcp` session, including the persistent runtime pane and its scrollback.

Herdr does not support switching full session UIs from inside an already-managed Herdr pane without nesting clients. `bun run tunnel` therefore refuses to attach when `HERDR_ENV=1`; detach the current Herdr UI first, then rerun it from the underlying host/SSH shell. `bun run tunnel:start` remains safe to use from inside another Herdr session when you only want to ensure the dedicated runtime is running.

Without Herdr configured, `bun run tunnel` retains the original foreground behavior.

In ChatGPT Developer Mode, create a custom app using a **Tunnel** connection and select the associated tunnel.

Useful operator commands:

```bash
bun run tunnel:start    # ensure the Herdr-owned tunnel is running; do not attach
bun run tunnel:attach   # attach directly to the persistent runtime terminal
bun run tunnel:session  # open the full dedicated Herdr session UI
bun run tunnel:stop     # stop the tunnel, preserving the runtime shell/session
bun run tunnel:info     # show runtime workspace/pane/terminal IDs and state
bun run tunnel:status   # probe health/readiness and require a successful control-plane poll
bun run tunnel:ui       # open the local tunnel admin UI
bun run tunnel:doctor   # run the full local preflight explicitly
```

That is the normal Secure MCP Tunnel setup and day-to-day flow.

### Direct Streamable HTTP through Cloudflare

The same MCP server can also listen directly over Streamable HTTP. This is useful as an independent transport path and keeps the OpenAI Secure MCP Tunnel optional rather than architectural. The HTTP server uses the same tool factory, managed-bash handoff, and optional Herdr `agent` runtime as stdio.

Run `bun run setup:http` (or copy `server/.env.example` to the gitignored `server/.env`) and configure the Cloudflare Access team domain, application audience, public hostname allowlist, and local working directory. This setup is independent of `bun run setup`, which continues to manage the OpenAI Secure MCP Tunnel. Keep the HTTP origin bound to loopback; Cloudflare Tunnel provides ingress.

```bash
bun run http:start
bun run cloudflare:start

bun run http:status
bun run cloudflare:status
```

Useful lifecycle commands are `http:stop`, `http:logs`, `cloudflare:stop`, and `cloudflare:logs`. `scripts/cloudflare.sh` uses `$CLOUDFLARED_CONFIG` or `~/.cloudflared/config.yml`, so it works with an existing named Cloudflare Tunnel without copying tunnel credentials into this repository.

For ChatGPT, create a custom MCP app using the public HTTPS Streamable HTTP endpoint (for example `https://mcp.example.com/mcp`) and Cloudflare Access Managed OAuth. Cloudflare authenticates the OAuth bearer token at the edge and injects the signed `Cf-Access-Jwt-Assertion`; pi-as-mcp verifies that assertion against the Access JWKS, issuer, and application audience before handling MCP requests.

Set `PI_MCP_LOG_FILE` to retain JSONL lifecycle diagnostics. The HTTP transport records request start/end, early connection closes, MCP session open/close, tool-call duration, cancellation state, and process signals without logging bearer tokens. This is particularly useful when comparing long-running ChatGPT behavior across the Secure Tunnel and direct HTTP paths.

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

-C, --cwd <dir>            Base directory for relative paths
-T, --tools <list>         Comma-separated subset of read,write,edit,bash,agent
    --bash-max-sync-seconds <n>
                            Synchronous bash handoff window
    --herdr-session <name> Enable agent with a dedicated named Herdr session
    --herdr-bin <path>     Herdr executable (default: herdr on PATH)
    --transport <kind>     stdio or http
    --host <host>          HTTP bind host (default 127.0.0.1)
    --port <port>          HTTP port (default 3333)
    --path <path>          MCP HTTP path (default /mcp)
    --auth <kind>          cloudflare-access or none
    --allowed-hosts <list> Extra HTTP Host allowlist
-V, --version              Print the package version
-h, --help                 Show help
```

The corresponding environment variables are:

```bash
PI_MCP_CWD="$HOME/dev"
PI_MCP_TOOLS="read,write,edit,bash,agent"
PI_MCP_BASH_MAX_SYNC_SECONDS="20"
PI_MCP_HERDR_SESSION="pi-as-mcp"
# PI_MCP_HERDR_BIN="/opt/homebrew/bin/herdr"
# PI_MCP_TRANSPORT="http"
# PI_MCP_HTTP_HOST="127.0.0.1"
# PI_MCP_HTTP_PORT="3333"
# PI_MCP_HTTP_PATH="/mcp"
# PI_MCP_HTTP_ALLOWED_HOSTS="mcp.example.com"
# PI_MCP_AUTH="cloudflare-access"
# PI_MCP_LOG_FILE="./logs/http-lifecycle.jsonl"
```

CLI flags override environment defaults. Without a Herdr session configured, omitting `PI_MCP_TOOLS` exposes the original four pi tools. When `PI_MCP_HERDR_SESSION` / `--herdr-session` is set, omitting the tool list exposes those four plus `agent`. Explicitly requesting `agent` without a Herdr session is an error.

`PI_MCP_HERDR_SESSION=default` is intentionally rejected. The project runtime must use a dedicated named session so pi-as-mcp never shares panes, focus, sockets, or persisted runtime state with the user's normal Herdr session. The named Herdr server is started automatically when needed and is deliberately left running across tunnel/MCP client disconnects.

For tunneled deployments, that session also owns a reserved Herdr workspace named `runtime`. Its root terminal is the canonical tunnel execution environment. Agent workspaces are separate and disposable; `runtime` is a reserved agent name so agent lifecycle cleanup cannot collide with infrastructure. The operator wrapper discovers the workspace and terminal from live Herdr state rather than PID files.

`PI_MCP_BASH_MAX_SYNC_SECONDS` is optional for generic stdio use; when omitted, bash keeps pi's native no-default-timeout behavior. The tunnel setup defaults it to 20 seconds; a command still running at that point is handed off to a durable local bash session instead of being killed or holding the tunnel request open.

`PI_MCP_CWD` / `--cwd` is a **path-resolution base, not a sandbox**. Relative paths resolve there, but pi's tools continue to accept absolute paths exactly as they do inside pi itself.

The ChatGPT tunnel setup stores these values plus `CONTROL_PLANE_TUNNEL_ID` and `CONTROL_PLANE_API_KEY` in the gitignored `tunnel/.env`. Changing the tool/runtime configuration requires restarting the running tunnel because the MCP subprocess receives it when it starts.

### Persistent agents with Herdr

The optional `agent` tool is a compact orchestration surface over the project-owned Herdr session:

- `list` — inspect managed agents and lifecycle state
- `start` — create an isolated Herdr workspace and launch a supported coding agent
- `prompt` — submit work with Herdr's atomic prompt+wait, capped below the tunnel deadline; longer work keeps running
- `wait` — wait briefly for lifecycle state (`idle`, `done`, `blocked`, etc.); waits are capped at 15 seconds for tunnel safety
- `read` — read agent terminal output
- `send_keys` — interact with approval/question UIs using logical terminal keys
- `close` — terminate the agent and remove its dedicated workspace from the pi-as-mcp session

Each started agent receives its own workspace in the dedicated session. Herdr itself owns the PTY and agent process, so closing ChatGPT, restarting the tunnel, or restarting pi-as-mcp does not kill the agent. `runtime` is reserved for the persistent tunnel shell and cannot be used as an agent name.

For operator visibility, `bun run tunnel:attach` attaches directly to the tunnel terminal and `bun run tunnel:session` opens the full session UI. Explicitly stop the whole Herdr runtime with `herdr session stop pi-as-mcp`; delete it only after stopping it with `herdr session delete pi-as-mcp`.

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

The repo-local tunnel support keeps OpenAI's tunnel client separate from the MCP bridge while optionally placing the tunnel process itself inside the dedicated Herdr runtime:

```text
operator terminal
   │  full named-session attach
   ▼
Herdr session: pi-as-mcp
   │
   ├── runtime workspace
   │      └── tunnel-client
   │             │ stdio
   │             ▼
   │         pi-as-mcp
   │             ├── read / write / edit / bash
   │             └── agent ───────────────┐
   │                                      │
   └── disposable agent workspaces ◄─────┘

ChatGPT ── OpenAI Secure MCP Tunnel ──► tunnel-client
```

Relevant files:

```text
scripts/setup.sh             one-command bootstrap/configuration wizard
scripts/tunnel.sh            tunnel lifecycle/doctor/status/UI operator wrapper
scripts/tunnel-runtime.mjs   persistent Herdr runtime workspace/PTY lifecycle manager
scripts/tunnel-install.sh    checksum-verified tunnel-client installer
tunnel/.env                  private local settings and runtime key (gitignored)
tunnel/profile.yaml          committed tunnel-client profile
bin/tunnel-client            pinned downloaded binary (gitignored)
```

The local tunnel admin UI is configured at `http://127.0.0.1:8080/ui`.

For a stdio MCP target, `doctor` validates local tunnel configuration but does not establish the real long-lived tunnel session. The actual control-plane connection and MCP subprocess lifecycle begin with the internal `foreground` command. With Herdr configured, the lifecycle manager submits that command into the reserved runtime pane and direct-attaches the operator terminal. If a healthy legacy tunnel already owns the configured health port outside that pane, startup refuses to create a duplicate and asks for a one-time migration instead.

### Long-running bash over a tunnel

Tunnel commands have a finite response lifetime, while pi's native bash tool intentionally has no default timeout. A synchronous build, test, decompilation, or analysis can therefore outlive the tunnel request even though the local process itself is healthy.

The tunnel setup sets `PI_MCP_BASH_MAX_SYNC_SECONDS=20`. In tunneled mode, that value is a **handoff window**, not a command timeout. If a command is still running after 20 seconds, `bash` returns successfully with a `session_id` while the process continues in its own process group with output and exit status persisted under the system temporary directory. Poll it with another `bash` call containing only `session_id`; pass `kill=true` with the session ID to terminate the process tree. For ChatGPT conversations still using an older frozen tool schema, `command=":session <id>"` and `command=":session <id> kill"` provide the same operations without requiring the new input fields. No `tmux` wrapper is required.

Managed jobs are deliberately independent of the originating MCP request. They remain pollable after the stdio MCP subprocess or tunnel is restarted because the command output, PID, and exit status are stored on disk. An explicit `timeout` argument still means a hard command lifetime and will terminate the process when reached.

Returning the initial MCP result before the control-plane deadline also avoids the stale-response-ID path in `tunnel-client`: deadline-retired stdio requests are tracked until their late response is consumed, and immediate reuse of the same JSON-RPC ID can otherwise be rejected while that ID remains retired.

To keep pi's original fully synchronous behavior for a non-tunneled deployment, omit `PI_MCP_BASH_MAX_SYNC_SECONDS`. To choose another handoff window, set the environment variable or pass `--bash-max-sync-seconds <seconds>`.

The tunnel-client installer currently defaults to official commit `cf3a41f23bc02382f19198d2f62fa854be9f8faa`, which contains the shared-stdio response-deadline fix and is the build used for this integration. The default commit path builds locally with Git and Go until a suitable fixed stable release is available.

To select a stable release explicitly:

```bash
TUNNEL_CLIENT_VERSION=vX.Y.Z ./scripts/tunnel-install.sh
```

To build another exact official commit:

```bash
TUNNEL_CLIENT_COMMIT=<full-40-character-sha> ./scripts/tunnel-install.sh
```

### tunnel-client v0.0.11 response-deadline bug

OpenAI tunnel-client `v0.0.11` has a known shared-stdio lifecycle bug ([openai/tunnel-client#34](https://github.com/openai/tunnel-client/issues/34)): when a tunneled request reaches its control-plane response deadline, the logical request can close the shared stdio connection. A later write then fails and `tunnel-client` shuts down the whole daemon. Long-running `bash` calls are a practical trigger.

OpenAI fixed the bug on upstream master in commit `c537a6febe25eac696cc25bbe8741ad64727368f`. The repo pins the later official commit `cf3a41f23bc02382f19198d2f62fa854be9f8faa`, which contains that fix. `scripts/tunnel.sh run` and `doctor` still warn when an installed client reports the affected `v0.0.11` line.

## Security

**This server provides local code execution by design.**

Pi's tools are unsandboxed, and the optional Herdr agents inherit the same host-level trust boundary:

- `read`, `write`, and `edit` accept absolute filesystem paths.
- `bash` executes arbitrary shell commands with the permissions of the pi-as-mcp process.
- `agent` can launch persistent interactive coding agents that themselves can execute commands and modify files according to their own configuration.
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
bun run smoke:herdr
bun run test
```

`bun run test` runs typechecking, a clean build, the core protocol smoke suite, cancellation and managed-bash regressions, Herdr agent integration, direct Streamable HTTP and Cloudflare Access authentication smokes, and the persistent Secure Tunnel runtime lifecycle smoke test.

The smoke suite exercises:

- MCP tool discovery and annotations
- text and image reads
- write/edit/bash behavior
- argument validation and tool error paths
- CLI and environment configuration
- tool subsets

The cancellation test starts a long-lived bash command, aborts the MCP request, verifies that pi kills the process tree rather than leaving it running in the background, and then immediately performs another MCP `bash` call to prove the stdio server itself remains usable after cancellation.

The managed-bash regression starts the server with a very short `PI_MCP_BASH_MAX_SYNC_SECONDS`, proves that a longer command yields a session ID before a remote-style deadline, restarts the MCP subprocess, polls the same job to successful completion, verifies explicit hard timeouts, and confirms that later bash calls remain usable.

The Herdr smoke test uses an isolated fake Herdr executable so CI does not need Herdr installed. It proves first-start versus reuse behavior, exercises the `agent` actions, and verifies that inherited `HERDR_SOCKET_PATH`, pane, tab, workspace, and session variables cannot leak into the dedicated runtime.

The tunnel-runtime smoke test separately proves that the named Herdr server and reserved `runtime` workspace are created once, subsequent starts reuse the same PTY, `run` targets the full dedicated named-session UI, explicit direct attach targets the persistent terminal, stop returns to the retained shell, and inherited caller-session routing variables remain isolated.

CI runs the suite at the minimum supported Node version and on current Node.

### Source layout

```text
src/
  index.ts             MCP stdio server, CLI/config, validation, dispatch
  tools.ts             tool factories and MCP annotations
  managed-bash.ts      tunnel-safe long-running bash session handoff/polling
  herdr.ts             dedicated named-session lifecycle and command adapter
  agent-tool.ts        compact Herdr-backed persistent agent MCP tool
scripts/
  setup.sh             interactive local bootstrap/configuration wizard
  smoke.mjs            protocol-level core-tool smoke tests
  smoke-herdr.mjs      isolated Herdr lifecycle/agent integration smoke test
  smoke-tunnel-runtime.mjs  isolated persistent tunnel/PTY lifecycle smoke test
  cancel.mjs           cancellation/process-tree test
  tunnel-runtime.mjs   persistent Herdr runtime workspace/PTY manager
  tunnel-install.sh    checksum-verified tunnel-client installer
  tunnel.sh            tunnel lifecycle/doctor/status/UI operator wrapper
tunnel/
  .env.example         local configuration template
  profile.yaml         OpenAI Secure MCP Tunnel profile
sandbox/
  ...                  throwaway default tunnel workspace
```

## License

MIT
