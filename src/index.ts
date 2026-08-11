#!/usr/bin/env node
/**
 * pi-as-mcp: expose pi's four default coding tools (read, write, edit, bash)
 * as an MCP server over stdio or Streamable HTTP. The agent loop is
 * intentionally out of scope.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
	createCloudflareAccessMiddleware,
	parseCloudflareAccessConfig,
} from "./cloudflare-auth.js";
import {
	ALL_TOOL_NAMES,
	createPiTools,
	MCP_ANNOTATIONS,
	type PiTool,
	type PiToolName,
} from "./tools.js";

type TransportKind = "stdio" | "http";
type AuthKind = "none" | "cloudflare-access";

interface Options {
	cwd: string;
	tools: PiToolName[];
	transport: TransportKind;
	host: string;
	port: number;
	path: string;
	auth: AuthKind;
	allowedHosts: string[];
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
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3333;
const DEFAULT_HTTP_PATH = "/mcp";

function printHelp(): void {
	const out = process.stdout;
	out.write("pi-as-mcp — pi's four default coding tools as an MCP server\n\n");
	out.write("Usage: pi-mcp [options]\n\n");
	out.write("Options:\n");
	out.write("  -C, --cwd <dir>          Base directory for relative paths.\n");
	out.write("                           Default: $PI_MCP_CWD, or process cwd.\n");
	out.write("  -T, --tools <list>       Comma-separated subset of: " + ALL_TOOL_NAMES.join(", ") + "\n");
	out.write("                           Default: $PI_MCP_TOOLS, or all four.\n");
	out.write("      --transport <kind>   stdio or http. Default: $PI_MCP_TRANSPORT or stdio.\n");
	out.write("      --host <host>        HTTP bind host. Default: $PI_MCP_HTTP_HOST or 127.0.0.1.\n");
	out.write("      --port <port>        HTTP port. Default: $PI_MCP_HTTP_PORT or 3333.\n");
	out.write("      --path <path>        MCP HTTP path. Default: $PI_MCP_HTTP_PATH or /mcp.\n");
	out.write("      --auth <kind>        HTTP auth: cloudflare-access or none.\n");
	out.write("                           Default: $PI_MCP_AUTH or cloudflare-access.\n");
	out.write("      --allowed-hosts <l>  Extra comma-separated HTTP Host allowlist.\n");
	out.write("                           Default: $PI_MCP_HTTP_ALLOWED_HOSTS.\n");
	out.write("  -V, --version            Show the package version.\n");
	out.write("  -h, --help               Show this help.\n\n");
	out.write("Cloudflare Access auth requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.\n");
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

function parseStringList(value: string | undefined): string[] {
	if (!value) return [];
	return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseTransport(value: string | undefined, source: string): TransportKind {
	const normalized = (value ?? "stdio").trim();
	if (normalized === "stdio" || normalized === "http") return normalized;
	throw new Error(`${source} must be one of: stdio, http`);
}

function parseAuth(value: string | undefined, source: string): AuthKind {
	const normalized = (value ?? "cloudflare-access").trim();
	if (normalized === "none" || normalized === "cloudflare-access") return normalized;
	throw new Error(`${source} must be one of: none, cloudflare-access`);
}

function parsePort(value: string | undefined, source: string): number {
	const port = Number(value ?? DEFAULT_HTTP_PORT);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`${source} must be an integer from 1 to 65535`);
	}
	return port;
}

function normalizeHttpPath(value: string | undefined): string {
	const path = (value ?? DEFAULT_HTTP_PATH).trim();
	if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
		throw new Error("HTTP MCP path must start with / and must not contain a query or fragment");
	}
	return path;
}

function parseArgs(argv: readonly string[]): Options {
	const envCwd = process.env.PI_MCP_CWD?.trim();
	const envTools = process.env.PI_MCP_TOOLS?.trim();
	const opts: Options = {
		cwd: envCwd || process.cwd(),
		tools: envTools ? parseToolList(envTools, "$PI_MCP_TOOLS") : [...ALL_TOOL_NAMES],
		transport: parseTransport(process.env.PI_MCP_TRANSPORT, "$PI_MCP_TRANSPORT"),
		host: process.env.PI_MCP_HTTP_HOST?.trim() || DEFAULT_HTTP_HOST,
		port: parsePort(process.env.PI_MCP_HTTP_PORT, "$PI_MCP_HTTP_PORT"),
		path: normalizeHttpPath(process.env.PI_MCP_HTTP_PATH),
		auth: parseAuth(process.env.PI_MCP_AUTH, "$PI_MCP_AUTH"),
		allowedHosts: parseStringList(process.env.PI_MCP_HTTP_ALLOWED_HOSTS),
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
			case "--transport": {
				const value = next();
				if (!value) throw new Error("--transport requires stdio or http");
				opts.transport = parseTransport(value, "--transport");
				break;
			}
			case "--host": {
				const value = next();
				if (!value) throw new Error("--host requires a hostname or address");
				opts.host = value;
				break;
			}
			case "--port": {
				const value = next();
				if (!value) throw new Error("--port requires a port number");
				opts.port = parsePort(value, "--port");
				break;
			}
			case "--path": {
				const value = next();
				if (!value) throw new Error("--path requires an HTTP path");
				opts.path = normalizeHttpPath(value);
				break;
			}
			case "--auth": {
				const value = next();
				if (!value) throw new Error("--auth requires none or cloudflare-access");
				opts.auth = parseAuth(value, "--auth");
				break;
			}
			case "--allowed-hosts": {
				const value = next();
				if (!value) throw new Error("--allowed-hosts requires a comma-separated list");
				opts.allowedHosts = parseStringList(value);
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

function createPiMcpServer(opts: Options): Server {
	const tools = createPiTools(opts.cwd, opts.tools);
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

	return server;
}

async function runStdio(opts: Options): Promise<void> {
	const server = createPiMcpServer(opts);
	await server.connect(new StdioServerTransport());
	logLifecycle("connected", { transport: "stdio" });
}

async function runHttp(opts: Options): Promise<void> {
	const allowedHosts = [...new Set([opts.host, "localhost", "127.0.0.1", ...opts.allowedHosts])];
	const app = createMcpExpressApp({ host: opts.host, allowedHosts });
	const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

	app.get("/healthz", (_req, res) => {
		res.json({ status: "ok", name: "pi-as-mcp", version: VERSION, sessions: sessions.size });
	});

	if (opts.auth === "cloudflare-access") {
		app.use(opts.path, createCloudflareAccessMiddleware(parseCloudflareAccessConfig(process.env)));
	} else if (opts.host !== "127.0.0.1" && opts.host !== "localhost" && opts.host !== "::1") {
		throw new Error("Refusing unauthenticated HTTP mode on a non-loopback bind address");
	}

	app.post(opts.path, async (req, res) => {
		const sessionId = req.header("mcp-session-id");
		try {
			if (sessionId) {
				const session = sessions.get(sessionId);
				if (!session) {
					res.status(404).json({
						jsonrpc: "2.0",
						error: { code: -32001, message: "Unknown MCP session" },
						id: null,
					});
					return;
				}
				await session.transport.handleRequest(req, res, req.body);
				return;
			}

			if (!isInitializeRequest(req.body)) {
				res.status(400).json({
					jsonrpc: "2.0",
					error: { code: -32000, message: "Missing MCP session ID" },
					id: null,
				});
				return;
			}

			const server = createPiMcpServer(opts);
			let transport: StreamableHTTPServerTransport;
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (newSessionId) => {
					sessions.set(newSessionId, { transport, server });
					logLifecycle("http_session_open", { session_id: newSessionId });
				},
				// SSE comments keep long-running calls alive through reverse proxies.
				keepAliveMs: 15_000,
			});
			transport.onclose = () => {
				const closedSessionId = transport.sessionId;
				if (closedSessionId) {
					sessions.delete(closedSessionId);
					logLifecycle("http_session_close", { session_id: closedSessionId });
				}
				void server.close().catch(() => undefined);
			};
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
		} catch {
			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: "2.0",
					error: { code: -32603, message: "Internal server error" },
					id: null,
				});
			}
		}
	});

	const getSession = (sessionId: string | undefined) => sessionId ? sessions.get(sessionId) : undefined;
	app.get(opts.path, async (req, res) => {
		const session = getSession(req.header("mcp-session-id"));
		if (!session) {
			res.status(400).send("Invalid or missing MCP session ID");
			return;
		}
		await session.transport.handleRequest(req, res);
	});
	app.delete(opts.path, async (req, res) => {
		const session = getSession(req.header("mcp-session-id"));
		if (!session) {
			res.status(400).send("Invalid or missing MCP session ID");
			return;
		}
		await session.transport.handleRequest(req, res);
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		const httpServer = app.listen(opts.port, opts.host, () => {
			logLifecycle("connected", {
				transport: "http",
				host: opts.host,
				port: opts.port,
				path: opts.path,
				auth: opts.auth,
			});
			resolveListen();
		});
		httpServer.once("error", rejectListen);
	});
}

async function main(): Promise<void> {
	installLifecycleDiagnostics();
	const opts = parseArgs(process.argv);
	logLifecycle("starting", {
		cwd: opts.cwd,
		tools: opts.tools.join(","),
		transport: opts.transport,
	});

	if (opts.transport === "stdio") {
		await runStdio(opts);
		return;
	}
	await runHttp(opts);
}

main().catch((error) => {
	process.stderr.write(`pi-as-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
