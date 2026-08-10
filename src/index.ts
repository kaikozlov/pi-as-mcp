#!/usr/bin/env node
/**
 * pi-as-mcp: expose pi's core coding tools (read, write, edit, bash) as an MCP
 * server over stdio. Designed for local desktop clients (ChatGPT, Claude
 * Desktop, Cursor, ...). The agent loop is out of scope: this server only
 * bridges tool calls to pi's tool implementations.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
	ALL_TOOL_NAMES,
	createPiTools,
	MCP_ANNOTATIONS,
	type PiTool,
	type PiToolName,
} from "./tools.js";

interface Options {
	cwd: string;
	tools: PiToolName[];
}

const VERSION = "0.1.0";

function printHelp(): void {
	const out = process.stdout;
	out.write("pi-as-mcp — pi's core coding tools as an MCP server (stdio)\n\n");
	out.write("Usage: pi-mcp [--cwd <dir>] [--tools <list>]\n\n");
	out.write("Options:\n");
	out.write("  -C, --cwd <dir>      Working directory tools resolve relative paths against.\n");
	out.write("                       Default: $PI_MCP_CWD, or the process working directory.\n");
	out.write("  -T, --tools <list>   Comma-separated subset of: " + ALL_TOOL_NAMES.join(", ") + "\n");
	out.write("                       Default: all four.\n");
	out.write("  -h, --help           Show this help.\n\n");
	out.write("Configures pi's read/write/edit/bash tools with no sandboxing. Absolute paths\n");
	out.write("outside --cwd are accepted, same as pi itself.\n");
}

const isPiToolName = (value: string): value is PiToolName =>
	(ALL_TOOL_NAMES as readonly string[]).includes(value);

function parseArgs(argv: readonly string[]): Options {
	const opts: Options = {
		cwd: process.env.PI_MCP_CWD ?? process.cwd(),
		tools: [...ALL_TOOL_NAMES],
	};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		const next = (): string | undefined => argv[++i];
		switch (arg) {
			case "-h":
			case "--help":
				printHelp();
				process.exit(0);
				break;
			case "-C":
			case "--cwd": {
				const value = next();
				if (!value) throw new Error(`${arg} requires a directory path`);
				opts.cwd = value;
				break;
			}
			case "-T":
			case "--tools": {
				const value = next();
				if (!value) throw new Error(`${arg} requires a comma-separated tool list`);
				const parsed = value
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0);
				const invalid = parsed.filter((s) => !isPiToolName(s));
				if (invalid.length > 0) {
					throw new Error(`Unknown tool(s): ${invalid.join(", ")}. Valid: ${ALL_TOOL_NAMES.join(", ")}`);
				}
				if (parsed.length === 0) throw new Error(`${arg} must list at least one tool`);
				opts.tools = parsed as PiToolName[];
				break;
			}
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return opts;
}

/**
 * Map pi's content blocks onto MCP content blocks. pi emits exactly two kinds:
 *   - { type: "text",  text }
 *   - { type: "image", data, mimeType }
 * Both are structurally identical to MCP text/image content; we normalize to be
 * explicit about the union rather than relying on a structural `as`-cast.
 */
function toMcpContent(
	content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	return content.map((block) => {
		if (block.type === "image") {
			return {
				type: "image",
				data: block.data ?? "",
				mimeType: block.mimeType ?? "application/octet-stream",
			};
		}
		return { type: "text", text: block.text ?? "" };
	});
}
/**
 * pi's `ToolDefinition.execute` types `ctx` (ExtensionContext) as required, but
 * every implementation treats it as optional — the runtime injects it only when
 * a session exists. An MCP server has no session/model context, so we omit it.
 */
type PiExecute = (
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: undefined,
) => Promise<{
	content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>;
}>;

async function main(): Promise<void> {
	const opts = parseArgs(process.argv);
	const tools: PiTool[] = createPiTools(opts.cwd, opts.tools);
	const byName = new Map<string, PiTool>(tools.map((t) => [t.name, t]));

	const server = new Server(
		{ name: "pi-as-mcp", version: VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				"pi's core coding tools: read, write, edit, bash. Relative paths resolve " +
				`against the working directory (${opts.cwd}); absolute paths are honored.`,
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map(({ name, definition }) => ({
			name,
			description: definition.description,
			// TypeBox embeds non-enumerable symbol keys; JSON round-trip yields a
			// clean JSON-Schema object identical to what pi advertises to models.
			inputSchema: JSON.parse(JSON.stringify(definition.parameters)) as Record<string, unknown>,
			annotations: MCP_ANNOTATIONS[name],
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const { name, arguments: args } = request.params;
		const tool = byName.get(name);
		if (!tool) {
			return {
				content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
				isError: true,
			};
		}
		const { definition } = tool;
		// Apply the tool's legacy-arg compat shim (edit tolerates several shapes).
		const params = definition.prepareArguments ? definition.prepareArguments(args ?? {}) : (args ?? {});
		// Route MCP's cancellation AbortSignal straight into pi's execute.
		const toolCallId = String(extra.requestId ?? globalThis.crypto.randomUUID());
		try {
			const result = await (definition.execute as unknown as PiExecute)(toolCallId, params, extra.signal, undefined, undefined);
			return { content: toMcpContent(result.content) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text" as const, text: message }], isError: true };
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	process.stderr.write(`pi-as-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
