# pi-as-mcp

Expose [pi](https://github.com/earendil-works/pi)'s core coding tools — **read**, **write**, **edit**, **bash** — as an [MCP](https://modelcontextprotocol.io) server over stdio. Designed so a desktop client (ChatGPT, Claude Desktop, Cursor, …) can read and modify files and run shell commands on your machine using pi's actual tool implementations.

The agent loop is out of scope. This server only bridges tool calls to pi's tool definitions — nothing more.

## How it works

It depends on the published [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) package and wraps its four `create*ToolDefinition` factories as MCP tools. The mapping is thin because pi's tool contract is nearly identical to MCP's:

| pi `ToolDefinition`                    | MCP                                            |
| -------------------------------------- | ---------------------------------------------- |
| `parameters` (TypeBox schema)          | `inputSchema` — TypeBox *is* JSON Schema (a JSON round-trip strips TypeBox's non-enumerable symbol metadata) |
| `execute` → `{content: (Text\|Image)[]}` | MCP content blocks (`{type:"text",text}` / `{type:"image",data,mimeType}`) are structurally identical |
| `execute(id, params, signal, …)`       | the client handler's `extra.signal` is passed straight in, so **MCP cancellation kills pi's bash process tree** |
| thrown error                           | `{content:[{type:"text",…}], isError:true}`    |

No reimplementation, no shims — it's pi's tools.

## Requirements

- Node.js **≥ 22.19** (matches pi's engine requirement)

## Install & build

```bash
npm install
npm run build        # tsc -> dist/, sets the executable bit on dist/index.js
```

## Usage

```bash
# Defaults: cwd = process working directory; all four tools enabled.
npm start
# equivalently:
node dist/index.js
```

### Flags

| Flag               | Description                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `-C, --cwd <dir>`  | Working directory tools resolve relative paths against. Default: `$PI_MCP_CWD`, or the process cwd. |
| `-T, --tools <list>` | Comma-separated subset of `read,write,edit,bash`. Default: all four.      |
| `-h, --help`       | Show help.                                                                  |

```bash
node dist/index.js --cwd ~/dev/myproject --tools read,bash
```

## Client configuration

Add the server to your MCP client's config. The `cwd` you set (or pass via `--cwd`) is where relative paths resolve.

**ChatGPT / Claude Desktop / generic stdio client:**

```jsonc
{
  "mcpServers": {
    "pi": {
      "command": "node",
      "args": ["/absolute/path/to/pi-as-mcp/dist/index.js"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

To expose only a subset, add `--tools` to `args`, e.g. `["…/dist/index.js", "--tools", "read,bash"]`.

## Tools

All paths may be relative (resolved against `--cwd`) or absolute. Line/byte truncation and temp-file spillover behavior are pi's defaults.

### `read`
Read a file's contents. Text files are truncated to pi's line/byte limits; images (jpg/png/gif/webp/bmp) are returned as image content.

| Param     | Type     | Description                                  |
| --------- | -------- | -------------------------------------------- |
| `path`    | string   | Path to the file (relative or absolute).     |
| `offset`  | number?  | 1-indexed line to start reading from.        |
| `limit`   | number?  | Maximum number of lines to read.             |

### `write`
Create or overwrite a file.

| Param     | Type     | Description                              |
| --------- | -------- | ---------------------------------------- |
| `path`    | string   | Path to the file (relative or absolute). |
| `content` | string   | Content to write.                        |

### `edit`
Make targeted exact-text replacements in a file. Each `edits[].oldText` must match a unique, non-overlapping region of the **original** file (edits are matched against the original, not applied incrementally).

| Param   | Type                              | Description            |
| ------- | --------------------------------- | ---------------------- |
| `path`  | string                            | Path to the file.      |
| `edits` | `{oldText,newText}[]`             | One or more replacements. |

### `bash`
Execute a shell command in the working directory. Streams stdout+stderr; output is truncated to pi's last-N-lines / byte limits and spilled to a temp file when truncated. Non-zero exit is surfaced as `isError: true`.

| Param     | Type     | Description                                         |
| --------- | -------- | --------------------------------------------------- |
| `command` | string   | Bash command to execute.                            |
| `timeout` | number?  | Timeout in seconds (optional; no default timeout).  |

## Security

These are pi's **unsandboxed** tools. Relative paths resolve against `--cwd`, but **absolute paths anywhere on the filesystem are honored**, and `bash` runs arbitrary commands — exactly as pi itself does. Configure the server and grant client access accordingly. If you need path confinement, that is a separate layer to add; pi's tools do not provide it.

## Development

```bash
npm run typecheck       # tsc --noEmit
npm run smoke           # end-to-end: spawn server over stdio, exercise all four tools
npm run smoke:cancel    # verify MCP cancellation propagates to pi's bash (kills the process tree)
```

Source layout:

```
src/
  tools.ts    # pi tool factories -> PiTool[] + schema/annotation helpers
  index.ts    # MCP Server (stdio): tools/list + tools/call handlers, CLI parsing
scripts/
  smoke.mjs   # protocol-level smoke test (read/write/edit/bash + error paths)
  cancel.mjs  # cancellation-propagation test
```

## License

MIT
