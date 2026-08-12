#!/usr/bin/env node
/**
 * pi-as-mcp: expose pi's four default coding tools (read, write, edit, bash)
 * as an MCP server over stdio. The agent loop is intentionally out of scope.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
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
	bashMaxSyncSeconds?: number;
}

interface PackageMetadata {
	version: string;
}

type LifecycleFields = Record<string, string | number | boolean | undefined>;

function logLifecycle(event: string, fields: LifecycleFields = {}): void {
	process.stderr.write(`${JSON.stringify({
		time: new Date().toISOString(),
		component: "pi-as-mcp",
		event,
		pid: process.pid,
		...fields,
	})}\n`);
}

function installLifecycleDiagnostics(): void {
	for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
		const handler = (): void => {
			logLifecycle("signal", { signal });
			process.removeListener(signal, handler);
			process.kill(process.pid, signal);
		};
		process.on(signal, handler);
	}
	process.stdin.on("end", () => logLifecycle("stdin_end"));
	process.stdin.on("close", () => logLifecycle("stdin_close"));
	process.on("uncaughtExceptionMonitor", (error) => {
		// Keep lifecycle logs diagnostic without echoing exception text that may
		// contain paths, command output, or other user-controlled content.
		logLifecycle("uncaught_exception", { name: error.name });
	});
}

const PACKAGE = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;
const VERSION = PACKAGE.version;

function printHelp(): void {
	const out = process.stdout;
	out.write("pi-as-mcp — pi's four default coding tools as an MCP server (stdio)\n\n");
	out.write("Usage: pi-mcp [--cwd <dir>] [--tools <list>]\n\n");
	out.write("Options:\n");
	out.write("  -C, --cwd <dir>      Base directory for relative paths.\n");
	out.write("                       Default: $PI_MCP_CWD, or the process working directory.\n");
	out.write("  -T, --tools <list>   Comma-separated subset of: " + ALL_TOOL_NAMES.join(", ") + "\n");
	out.write("                       Default: $PI_MCP_TOOLS, or all four.\n");
	out.write("      --bash-max-sync-seconds <n>\n");
	out.write("                       Optional synchronous wait before managed background handoff.\n");
	out.write("                       Default: $PI_MCP_BASH_MAX_SYNC_SECONDS, or native unlimited bash.\n");
	out.write("  -V, --version        Show the package version.\n");
	out.write("  -h, --help           Show this help.\n\n");
	out.write("These are pi's unsandboxed tools. --cwd only controls relative-path resolution;\n");
	out.write("absolute paths remain accessible, exactly as in pi itself.\n");
}

const isPiToolName = (value: string): value is PiToolName =>
	(ALL_TOOL_NAMES as readonly string[]).includes(value);

function parseToolList(value: string, source: string): PiToolName[] {
	const parsed = value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	const invalid = parsed.filter((item) => !isPiToolName(item));

	if (invalid.length > 0) {
		throw new Error(`Unknown tool(s) in ${source}: ${invalid.join(", ")}. Valid: ${ALL_TOOL_NAMES.join(", ")}`);
	}
	if (parsed.length === 0) throw new Error(`${source} must list at least one tool`);

	return [...new Set(parsed)] as PiToolName[];
}

function parsePositiveSeconds(value: string, source: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${source} must be a positive number of seconds`);
	}
	return parsed;
}

function parseArgs(argv: readonly string[]): Options {
	const envCwd = process.env.PI_MCP_CWD?.trim();
	const envTools = process.env.PI_MCP_TOOLS?.trim();
	const envBashMaxSync = process.env.PI_MCP_BASH_MAX_SYNC_SECONDS?.trim();
	const opts: Options = {
		cwd: envCwd || process.cwd(),
		tools: envTools ? parseToolList(envTools, "$PI_MCP_TOOLS") : [...ALL_TOOL_NAMES],
		bashMaxSyncSeconds: envBashMaxSync
			? parsePositiveSeconds(envBashMaxSync, "$PI_MCP_BASH_MAX_SYNC_SECONDS")
			: undefined,
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
			case "-V":
			case "--version":
				process.stdout.write(`${VERSION}\n`);
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
				opts.tools = parseToolList(value, arg);
				break;
			}
			case "--bash-max-sync-seconds": {
				const value = next();
				if (!value) throw new Error(`${arg} requires a positive number of seconds`);
				opts.bashMaxSyncSeconds = parsePositiveSeconds(value, arg);
				break;
			}
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	opts.cwd = resolve(opts.cwd);
	try {
		if (!statSync(opts.cwd).isDirectory()) {
			throw new Error(`Working directory is not a directory: ${opts.cwd}`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Working directory is not")) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot access working directory ${opts.cwd}: ${detail}`);
	}

	return opts;
}

/** Convert pi's text/image content blocks into MCP content blocks. */
function toMcpContent(
	content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	return content.map((block) => {
		if (block.type === "text" && typeof block.text === "string") {
			return { type: "text", text: block.text };
		}
		if (
			block.type === "image" &&
			typeof block.data === "string" &&
			typeof block.mimeType === "string"
		) {
			return { type: "image", data: block.data, mimeType: block.mimeType };
		}
		throw new Error(`Unsupported or malformed pi content block: ${block.type}`);
	});
}

/**
 * pi's ToolDefinition.execute requires an ExtensionContext in its public type,
 * but the four built-in tool implementations do not require one. An MCP server
 * has no pi session/model context, so the bridge intentionally supplies none.
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

function cleanSchema(tool: PiTool): Record<string, unknown> {
	// TypeBox schemas contain non-enumerable symbol metadata. The JSON round-trip
	// leaves the plain JSON Schema that MCP clients and AJV expect.
	return JSON.parse(JSON.stringify(tool.definition.parameters)) as Record<string, unknown>;
}

async function main(): Promise<void> {
	installLifecycleDiagnostics();
	const opts = parseArgs(process.argv);
	logLifecycle("starting", { cwd: opts.cwd, tools: opts.tools.join(",") });
	const tools = createPiTools(opts.cwd, opts.tools, {
		bashMaxSyncSeconds: opts.bashMaxSyncSeconds,
	});
	const byName = new Map<string, PiTool>(tools.map((tool) => [tool.name, tool]));
	const schemas = new Map<string, Record<string, unknown>>(tools.map((tool) => [tool.name, cleanSchema(tool)]));
	const validatorProvider = new AjvJsonSchemaValidator();
	const validators = new Map(
		[...schemas].map(([name, schema]) => [name, validatorProvider.getValidator(schema)] as const),
	);
	const guidelines = tools.flatMap(({ definition }) => definition.promptGuidelines ?? []);
	const instructions = [
		`pi's coding tools (${opts.tools.join(", ")}) are available in ${opts.cwd}.`,
		"Relative paths resolve against that working directory; absolute paths are honored.",
		...guidelines,
	].join("\n");

	const server = new Server(
		{ name: "pi-as-mcp", version: VERSION },
		{ capabilities: { tools: {} }, instructions },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map(({ name, definition }) => ({
			name,
			description: definition.description,
			inputSchema: schemas.get(name) ?? {},
			annotations: { ...MCP_ANNOTATIONS[name], title: definition.label },
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const { name, arguments: args } = request.params;
		const requestId = String(extra.requestId ?? globalThis.crypto.randomUUID());
		const startedAt = Date.now();
		logLifecycle("tool_call_start", { tool: name, request_id: requestId });
		const tool = byName.get(name);
		if (!tool) {
			logLifecycle("tool_call_end", {
				tool: name,
				request_id: requestId,
				duration_ms: Date.now() - startedAt,
				unknown_tool: true,
			});
			return {
				content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
				isError: true,
			};
		}

		try {
			const rawParams = tool.definition.prepareArguments
				? tool.definition.prepareArguments(args ?? {})
				: (args ?? {});
			const validate = validators.get(name);
			if (!validate) throw new Error(`No argument validator registered for tool: ${name}`);
			const validation = validate(rawParams);
			if (!validation.valid) {
				return {
					content: [{ type: "text" as const, text: `Invalid arguments for ${name}: ${validation.errorMessage}` }],
					isError: true,
				};
			}

			const result = await (tool.definition.execute as unknown as PiExecute)(
				requestId,
				validation.data,
				extra.signal,
				undefined,
				undefined,
			);
			return { content: toMcpContent(result.content) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text" as const, text: message }], isError: true };
		} finally {
			logLifecycle("tool_call_end", {
				tool: name,
				request_id: requestId,
				duration_ms: Date.now() - startedAt,
				aborted: extra.signal?.aborted ?? false,
			});
		}
	});

	await server.connect(new StdioServerTransport());
	logLifecycle("connected");
}

main().catch((error) => {
	process.stderr.write(`pi-as-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
