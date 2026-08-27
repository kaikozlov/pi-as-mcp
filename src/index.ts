#!/usr/bin/env node
/**
 * pi-as-mcp: expose pi's core coding tools as MCP over stdio or Streamable HTTP,
 * with an optional Herdr-backed persistent `agent` tool.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
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
import { HerdrRuntime } from "./herdr.js";
import {
	createTools,
	MCP_ANNOTATIONS,
	PI_TOOL_NAMES,
	TOOL_SELECTORS,
	type McpTool,
	type ToolSelector,
} from "./tools.js";

type TransportKind = "stdio" | "http";
type AuthKind = "none" | "cloudflare-access";

interface Options {
	cwd: string;
	tools: ToolSelector[];
	bashMaxSyncSeconds?: number;
	maxAgents: number;
	herdrSession?: string;
	herdrBin?: string;
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
	const line = `${JSON.stringify({
		time: new Date().toISOString(),
		component: "pi-as-mcp",
		event,
		pid: process.pid,
		...fields,
	})}\n`;
	process.stderr.write(line);
	const logFile = process.env.PI_MCP_LOG_FILE?.trim();
	if (logFile) {
		try {
			appendFileSync(resolve(logFile), line, { encoding: "utf8", mode: 0o600 });
		} catch {
			// Diagnostics must never make the MCP server unavailable.
		}
	}
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
	out.write("pi-as-mcp — pi coding tools, with optional persistent agents, over MCP stdio or HTTP\n\n");
	out.write("Usage: pi-mcp [options]\n\n");
	out.write("Options:\n");
	out.write("  -C, --cwd <dir>          Base directory for relative paths.\n");
	out.write("                           Default: $PI_MCP_CWD, or process cwd.\n");
	out.write("  -T, --tools <list>       Comma-separated subset of: " + TOOL_SELECTORS.join(", ") + "\n");
	out.write("                           Default: $PI_MCP_TOOLS, or all enabled tools.\n");
	out.write("      --bash-max-sync-seconds <n>\n");
	out.write("                           Optional synchronous wait before managed background handoff.\n");
	out.write("                           Default: $PI_MCP_BASH_MAX_SYNC_SECONDS, or native unlimited bash.\n");
	out.write("      --max-agents <n>      Optional retained-agent workspace limit; 0 disables it.\n");
	out.write("                           Default: $PI_MCP_MAX_AGENTS or 0.\n");
	out.write("      --herdr-session <n>  Enable agent with a dedicated named Herdr session.\n");
	out.write("                           Default: $PI_MCP_HERDR_SESSION; unset disables Herdr.\n");
	out.write("      --herdr-bin <path>   Herdr executable. Default: $PI_MCP_HERDR_BIN, or herdr on PATH.\n");
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
	out.write("Set PI_MCP_LOG_FILE to persist lifecycle diagnostics as JSONL.\n");
	out.write("These are pi's unsandboxed tools. --cwd controls relative-path resolution only;\n");
	out.write("absolute paths remain accessible, exactly as in pi itself.\n");
}

const isToolSelector = (value: string): value is ToolSelector =>
	(TOOL_SELECTORS as readonly string[]).includes(value);

function parseToolList(value: string, source: string): ToolSelector[] {
	const parsed = value.split(",").map((item) => item.trim()).filter(Boolean);
	const invalid = parsed.filter((item) => !isToolSelector(item));
	if (invalid.length > 0) {
		throw new Error(`Unknown tool(s) in ${source}: ${invalid.join(", ")}. Valid: ${TOOL_SELECTORS.join(", ")}`);
	}
	if (parsed.length === 0) throw new Error(`${source} must list at least one tool`);
	return [...new Set(parsed)] as ToolSelector[];
}

function parseNonNegativeInteger(value: string | undefined, source: string): number {
	const parsed = Number(value ?? 0);
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${source} must be a non-negative integer`);
	return parsed;
}

function parseStringList(value: string | undefined): string[] {
	if (!value) return [];
	return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function parsePositiveSeconds(value: string, source: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${source} must be a positive number of seconds`);
	return parsed;
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
	const envBashMaxSync = process.env.PI_MCP_BASH_MAX_SYNC_SECONDS?.trim();
	const envMaxAgents = process.env.PI_MCP_MAX_AGENTS?.trim();
	const envHerdrSession = process.env.PI_MCP_HERDR_SESSION?.trim();
	const envHerdrBin = process.env.PI_MCP_HERDR_BIN?.trim();
	let toolsExplicit = !!envTools;
	const opts: Options = {
		cwd: envCwd || process.cwd(),
		tools: envTools ? parseToolList(envTools, "$PI_MCP_TOOLS") : envHerdrSession ? [...PI_TOOL_NAMES, "agent"] : [...PI_TOOL_NAMES],
		bashMaxSyncSeconds: envBashMaxSync ? parsePositiveSeconds(envBashMaxSync, "$PI_MCP_BASH_MAX_SYNC_SECONDS") : undefined,
		maxAgents: parseNonNegativeInteger(envMaxAgents, "$PI_MCP_MAX_AGENTS"),
		herdrSession: envHerdrSession || undefined,
		herdrBin: envHerdrBin || undefined,
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
			case "-h": case "--help": printHelp(); process.exit(0); break;
			case "-V": case "--version": process.stdout.write(`${VERSION}\n`); process.exit(0); break;
			case "-C": case "--cwd": { const value = next(); if (!value) throw new Error(`${arg} requires a directory path`); opts.cwd = value; break; }
			case "-T": case "--tools": { const value = next(); if (!value) throw new Error(`${arg} requires a comma-separated tool list`); opts.tools = parseToolList(value, arg); toolsExplicit = true; break; }
			case "--bash-max-sync-seconds": { const value = next(); if (!value) throw new Error(`${arg} requires a positive number of seconds`); opts.bashMaxSyncSeconds = parsePositiveSeconds(value, arg); break; }
			case "--max-agents": { const value = next(); if (value === undefined) throw new Error(`${arg} requires a non-negative integer`); opts.maxAgents = parseNonNegativeInteger(value, arg); break; }
			case "--herdr-session": { const value = next()?.trim(); if (!value) throw new Error(`${arg} requires a named Herdr session`); opts.herdrSession = value; break; }
			case "--herdr-bin": { const value = next()?.trim(); if (!value) throw new Error(`${arg} requires an executable path`); opts.herdrBin = value; break; }
			case "--transport": { const value = next(); if (!value) throw new Error("--transport requires stdio or http"); opts.transport = parseTransport(value, "--transport"); break; }
			case "--host": { const value = next(); if (!value) throw new Error("--host requires a hostname or address"); opts.host = value; break; }
			case "--port": { const value = next(); if (!value) throw new Error("--port requires a port number"); opts.port = parsePort(value, "--port"); break; }
			case "--path": { const value = next(); if (!value) throw new Error("--path requires an HTTP path"); opts.path = normalizeHttpPath(value); break; }
			case "--auth": { const value = next(); if (!value) throw new Error("--auth requires none or cloudflare-access"); opts.auth = parseAuth(value, "--auth"); break; }
			case "--allowed-hosts": { const value = next(); if (!value) throw new Error("--allowed-hosts requires a comma-separated list"); opts.allowedHosts = parseStringList(value); break; }
			default: throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!toolsExplicit) opts.tools = opts.herdrSession ? [...PI_TOOL_NAMES, "agent"] : [...PI_TOOL_NAMES];
	const wantsAgent = opts.tools.includes("agent") || opts.tools.some((tool) => !PI_TOOL_NAMES.includes(tool as (typeof PI_TOOL_NAMES)[number]));
	if (wantsAgent && !opts.herdrSession) throw new Error("Agent tools require --herdr-session or $PI_MCP_HERDR_SESSION");
	if (opts.herdrSession === "default") throw new Error("pi-as-mcp requires a dedicated named Herdr session; 'default' is not allowed");

	opts.cwd = resolve(opts.cwd);
	try {
		if (!statSync(opts.cwd).isDirectory()) throw new Error(`Working directory is not a directory: ${opts.cwd}`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Working directory is not")) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot access working directory ${opts.cwd}: ${detail}`);
	}
	return opts;
}

function toMcpContent(
	content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	return content.map((block) => {
		if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") return { type: "image", data: block.data, mimeType: block.mimeType };
		throw new Error(`Unsupported or malformed pi content block: ${block.type}`);
	});
}

type PiExecute = (
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: undefined,
) => Promise<{ content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }> }>;

function cleanSchema(tool: McpTool): Record<string, unknown> {
	return JSON.parse(JSON.stringify(tool.definition.parameters)) as Record<string, unknown>;
}

async function createHerdrRuntime(opts: Options): Promise<HerdrRuntime | undefined> {
	const wantsAgent = opts.tools.includes("agent") || opts.tools.some((tool) => !PI_TOOL_NAMES.includes(tool as (typeof PI_TOOL_NAMES)[number]));
	if (!wantsAgent) return undefined;
	const herdr = new HerdrRuntime({ session: opts.herdrSession!, cwd: opts.cwd, binary: opts.herdrBin });
	try {
		await herdr.ensureReady();
		const catalog = await herdr.agentCatalog();
		logLifecycle("herdr_ready", { session: herdr.session, agent_kinds: catalog.length });
		return herdr;
	} catch (error) {
		logLifecycle("herdr_unavailable", {
			session: herdr.session,
			message: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function createPiMcpServer(opts: Options, herdr: HerdrRuntime | undefined): Server {
	const enabledSelectors = herdr
		? opts.tools
		: opts.tools.filter((tool) => PI_TOOL_NAMES.includes(tool as (typeof PI_TOOL_NAMES)[number]));
	const tools = createTools(opts.cwd, enabledSelectors, { bashMaxSyncSeconds: opts.bashMaxSyncSeconds, herdr, maxAgents: opts.maxAgents });
	const byName = new Map<string, McpTool>(tools.map((tool) => [tool.name, tool]));
	const schemas = new Map<string, Record<string, unknown>>(tools.map((tool) => [tool.name, cleanSchema(tool)]));
	const validatorProvider = new AjvJsonSchemaValidator();
	const validators = new Map([...schemas].map(([name, schema]) => [name, validatorProvider.getValidator(schema)] as const));
	const guidelines = tools.flatMap(({ definition }) => definition.promptGuidelines ?? []);
	const instructions = [
		`pi-as-mcp tools (${tools.map((tool) => tool.name).join(", ")}) are available in ${opts.cwd}.`,
		"Relative paths resolve against that working directory; absolute paths are honored.",
		...(herdr
			? [`Persistent agents are isolated in the dedicated Herdr session ${herdr.session}.`]
			: opts.herdrSession
				? ["Persistent subagent tools are unavailable because Herdr initialization/catalog discovery failed; core pi tools remain usable."]
				: []),
		...guidelines,
	].join("\n");
	const server = new Server({ name: "pi-as-mcp", version: VERSION }, { capabilities: { tools: {} }, instructions });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map(({ name, definition }) => ({ name, description: definition.description, inputSchema: schemas.get(name) ?? {}, annotations: { ...MCP_ANNOTATIONS[name], title: definition.label } })),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const { name, arguments: args } = request.params;
		const requestId = String(extra.requestId ?? randomUUID());
		const startedAt = Date.now();
		logLifecycle("tool_call_start", { tool: name, request_id: requestId });
		const tool = byName.get(name);
		if (!tool) {
			logLifecycle("tool_call_end", { tool: name, request_id: requestId, duration_ms: Date.now() - startedAt, unknown_tool: true });
			return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
		}
		try {
			const rawParams = tool.definition.prepareArguments ? tool.definition.prepareArguments(args ?? {}) : (args ?? {});
			const validate = validators.get(name);
			if (!validate) throw new Error(`No argument validator registered for tool: ${name}`);
			const validation = validate(rawParams);
			if (!validation.valid) return { content: [{ type: "text" as const, text: `Invalid arguments for ${name}: ${validation.errorMessage}` }], isError: true };
			const result = await (tool.definition.execute as unknown as PiExecute)(requestId, validation.data, extra.signal, undefined, undefined);
			return { content: toMcpContent(result.content) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text" as const, text: message }], isError: true };
		} finally {
			logLifecycle("tool_call_end", { tool: name, request_id: requestId, duration_ms: Date.now() - startedAt, aborted: extra.signal?.aborted ?? false });
		}
	});
	return server;
}

async function runStdio(opts: Options, herdr: HerdrRuntime | undefined): Promise<void> {
	const server = createPiMcpServer(opts, herdr);
	await server.connect(new StdioServerTransport());
	logLifecycle("connected", { transport: "stdio" });
}

async function runHttp(opts: Options, herdr: HerdrRuntime | undefined): Promise<void> {
	const allowedHosts = [...new Set([opts.host, "localhost", "127.0.0.1", ...opts.allowedHosts])];
	const app = createMcpExpressApp({ host: opts.host, allowedHosts });
	const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server; openedAt: number }>();

	app.use((req, res, next) => {
		const requestId = randomUUID();
		const startedAt = Date.now();
		const requestPath = req.originalUrl.split("?", 1)[0] || req.path;
		let finished = false;
		logLifecycle("http_request_start", { request_id: requestId, method: req.method, path: requestPath, has_session: !!req.header("mcp-session-id") });
		res.once("finish", () => {
			finished = true;
			logLifecycle("http_request_end", { request_id: requestId, method: req.method, path: requestPath, status: res.statusCode, duration_ms: Date.now() - startedAt, closed_early: false });
		});
		res.once("close", () => {
			if (!finished) logLifecycle("http_request_end", { request_id: requestId, method: req.method, path: requestPath, status: res.statusCode, duration_ms: Date.now() - startedAt, closed_early: true });
		});
		next();
	});

	app.get("/healthz", (_req, res) => {
		res.json({ status: "ok", name: "pi-as-mcp", version: VERSION, sessions: sessions.size, uptime_seconds: Math.floor(process.uptime()) });
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
					res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown MCP session" }, id: null });
					return;
				}
				await session.transport.handleRequest(req, res, req.body);
				return;
			}
			if (!isInitializeRequest(req.body)) {
				res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing MCP session ID" }, id: null });
				return;
			}

			const server = createPiMcpServer(opts, herdr);
			let transport: StreamableHTTPServerTransport;
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (newSessionId) => {
					sessions.set(newSessionId, { transport, server, openedAt: Date.now() });
					logLifecycle("http_session_open", { session_id: newSessionId, active_sessions: sessions.size });
				},
				keepAliveMs: 15_000,
			});
			transport.onclose = () => {
				const closedSessionId = transport.sessionId;
				if (closedSessionId) {
					const session = sessions.get(closedSessionId);
					sessions.delete(closedSessionId);
					logLifecycle("http_session_close", { session_id: closedSessionId, lifetime_ms: session ? Date.now() - session.openedAt : undefined, active_sessions: sessions.size });
				}
				void server.close().catch(() => undefined);
			};
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
		} catch (error) {
			logLifecycle("http_request_error", { name: error instanceof Error ? error.name : "unknown" });
			if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
		}
	});

	const getSession = (sessionId: string | undefined) => sessionId ? sessions.get(sessionId) : undefined;
	app.get(opts.path, async (req, res) => {
		const session = getSession(req.header("mcp-session-id"));
		if (!session) { res.status(400).send("Invalid or missing MCP session ID"); return; }
		await session.transport.handleRequest(req, res);
	});
	app.delete(opts.path, async (req, res) => {
		const session = getSession(req.header("mcp-session-id"));
		if (!session) { res.status(400).send("Invalid or missing MCP session ID"); return; }
		await session.transport.handleRequest(req, res);
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		// Express 5 invokes the listen callback with an Error when bind fails.
		// Treat that as startup failure; ignoring the callback argument makes an
		// EADDRINUSE look like a successful connection followed by a clean exit.
		app.listen(opts.port, opts.host, (error?: Error) => {
			if (error) {
				rejectListen(error);
				return;
			}
			logLifecycle("connected", { transport: "http", host: opts.host, port: opts.port, path: opts.path, auth: opts.auth });
			resolveListen();
		});
	});
}

async function main(): Promise<void> {
	installLifecycleDiagnostics();
	const opts = parseArgs(process.argv);
	logLifecycle("starting", { cwd: opts.cwd, tools: opts.tools.join(","), herdr_session: opts.herdrSession, transport: opts.transport });
	const herdr = await createHerdrRuntime(opts);
	if (opts.transport === "stdio") await runStdio(opts, herdr);
	else await runHttp(opts, herdr);
}

main().catch((error) => {
	process.stderr.write(`pi-as-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
