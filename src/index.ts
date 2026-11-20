#!/usr/bin/env bun
/**
 * pi-as-mcp: expose pi's core coding tools as MCP over stdio or Streamable HTTP,
 * with an optional Herdr-backed persistent `agent` tool.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	classifyInboundRequest,
	createMcpHandler,
	isJSONRPCRequest,
	PROTOCOL_VERSION_META_KEY,
	ProtocolError,
	ProtocolErrorCode,
	Server,
	UnsupportedProtocolVersionError,
	type JsonSchemaType,
	type JsonSchemaValidator,
	type Tool,
} from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import {
	createCloudflareAccessGuard,
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
	defaultAgent?: string;
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
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const SSE_OPEN_COMMENT = new TextEncoder().encode(":\n\n");
const TOOL_CALL_LIMIT = 60;
const TOOL_CALL_WINDOW_MS = 10_000;

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
	out.write("      --default-agent <k>   Default Herdr agent kind when spawn_agent omits kind.\n");
	out.write("                           Default: $PI_MCP_DEFAULT_AGENT, or omp when installed.\n");
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
	const envDefaultAgent = process.env.PI_MCP_DEFAULT_AGENT?.trim();
	const envHerdrSession = process.env.PI_MCP_HERDR_SESSION?.trim();
	const envHerdrBin = process.env.PI_MCP_HERDR_BIN?.trim();
	let toolsExplicit = !!envTools;
	const opts: Options = {
		cwd: envCwd || process.cwd(),
		tools: envTools ? parseToolList(envTools, "$PI_MCP_TOOLS") : envHerdrSession ? [...PI_TOOL_NAMES, "agent"] : [...PI_TOOL_NAMES],
		bashMaxSyncSeconds: envBashMaxSync ? parsePositiveSeconds(envBashMaxSync, "$PI_MCP_BASH_MAX_SYNC_SECONDS") : undefined,
		maxAgents: parseNonNegativeInteger(envMaxAgents, "$PI_MCP_MAX_AGENTS"),
		defaultAgent: envDefaultAgent || undefined,
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
			case "--default-agent": { const value = next()?.trim(); if (!value) throw new Error(`${arg} requires an agent kind`); opts.defaultAgent = value; break; }
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

type PiResult = {
	content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
};

type PiExecute = (
	toolCallId: string,
	params: unknown,
	signal: AbortSignal,
	onUpdate: undefined,
	ctx: undefined,
) => Promise<PiResult>;

function toolError(text: string) {
	return { content: [{ type: "text" as const, text }], isError: true };
}

async function createHerdrRuntime(opts: Options): Promise<HerdrRuntime | undefined> {
	const wantsAgent = opts.tools.includes("agent") || opts.tools.some((tool) => !PI_TOOL_NAMES.includes(tool as (typeof PI_TOOL_NAMES)[number]));
	if (!wantsAgent) return undefined;
	const herdr = new HerdrRuntime({ session: opts.herdrSession!, cwd: opts.cwd, binary: opts.herdrBin });
	try {
		await herdr.ensureReady();
		const catalog = await herdr.agentCatalog();
		if (opts.defaultAgent) {
			const installed = catalog.some((entry) =>
				entry.kind === opts.defaultAgent && (entry.integration === "current" || entry.integration === "outdated")
			);
			if (!installed) {
				const available = catalog
					.filter((entry) => entry.integration === "current" || entry.integration === "outdated")
					.map((entry) => entry.kind);
				throw new Error(`Configured default agent '${opts.defaultAgent}' is not installed. Available: ${available.join(", ") || "none"}`);
			}
		}
		logLifecycle("herdr_ready", { session: herdr.session, agent_kinds: catalog.length, ...(opts.defaultAgent ? { default_agent: opts.defaultAgent } : {}) });
		return herdr;
	} catch (error) {
		logLifecycle("herdr_unavailable", {
			session: herdr.session,
			message: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function createPiMcpServerFactory(opts: Options, herdr: HerdrRuntime | undefined): () => Server {
	const enabledSelectors = herdr
		? opts.tools
		: opts.tools.filter((tool) => PI_TOOL_NAMES.includes(tool as (typeof PI_TOOL_NAMES)[number]));
	const tools = createTools(opts.cwd, enabledSelectors, { bashMaxSyncSeconds: opts.bashMaxSyncSeconds, herdr, maxAgents: opts.maxAgents, defaultAgent: opts.defaultAgent });
	const validatorProvider = new AjvJsonSchemaValidator();
	const byName = new Map<string, { definition: McpTool["definition"]; validate: JsonSchemaValidator<unknown> }>();
	const catalog = tools.map(({ name, definition }): Tool => {
		const inputSchema = JSON.parse(JSON.stringify(definition.parameters)) as Tool["inputSchema"] & JsonSchemaType;
		byName.set(name, { definition, validate: validatorProvider.getValidator(inputSchema) });
		return { name, description: definition.description, inputSchema, annotations: { ...MCP_ANNOTATIONS[name], title: definition.label } };
	});
	let windowEndsAt = 0;
	let remainingCalls = 0;
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
	return () => {
		const server = new Server({ name: "pi-as-mcp", version: VERSION }, { capabilities: { tools: {} }, instructions });
		server.setRequestHandler("tools/list", async () => ({ tools: catalog }));
		server.setRequestHandler("tools/call", async ({ params }, { mcpReq }) => {
			const { name, arguments: args } = params;
			const requestId = String(mcpReq.id);
			const startedAt = Date.now();
			logLifecycle("tool_call_start", { tool: name, request_id: requestId });
			try {
				const tool = byName.get(name);
				if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);

				const now = performance.now();
				if (now >= windowEndsAt) {
					windowEndsAt = now + TOOL_CALL_WINDOW_MS;
					remainingCalls = TOOL_CALL_LIMIT;
				}
				if (remainingCalls === 0) return toolError("Tool call rate limit reached. Try again after 10 seconds.");
				remainingCalls--;

				const { definition, validate } = tool;
				let result: PiResult;
				try {
					const rawParams = definition.prepareArguments ? definition.prepareArguments(args ?? {}) : (args ?? {});
					const validation = validate(rawParams);
					if (!validation.valid) return toolError(`Invalid arguments for ${name}: ${validation.errorMessage}`);
					result = await (definition.execute as unknown as PiExecute)(requestId, validation.data, mcpReq.signal, undefined, undefined);
				} catch (error) {
					return toolError(error instanceof Error ? error.message : String(error));
				}
				return { content: toMcpContent(result.content), isError: result.isError };
			} finally {
				logLifecycle("tool_call_end", { tool: name, request_id: requestId, duration_ms: Date.now() - startedAt, aborted: mcpReq.signal.aborted });
			}
		});
		return server;
	};
}

class VersionCheckedStdioTransport extends StdioServerTransport {
	override start(): Promise<void> {
		const deliver = this.onmessage;
		this.onmessage = (message) => {
			// SDK 2.4.0 pins the era. It does not check every request's revision.
			if (isJSONRPCRequest(message)) {
				const requested = message.params?._meta?.[PROTOCOL_VERSION_META_KEY];
				if (typeof requested === "string" && requested !== MODERN_PROTOCOL_VERSION &&
					classifyInboundRequest({ httpMethod: "POST", body: message }).kind === "modern") {
					const error = new UnsupportedProtocolVersionError({ requested, supported: [MODERN_PROTOCOL_VERSION] });
					void this.send({
						jsonrpc: "2.0", id: message.id,
						error: { code: error.code, message: error.message, data: error.data },
					}).catch((error) => this.onerror?.(error));
					return;
				}
			}
			deliver?.(message);
		};
		return super.start();
	}
}

function runStdio(createServer: () => Server): void {
	serveStdio(createServer, { legacy: "reject", transport: new VersionCheckedStdioTransport() });
	logLifecycle("connected", { transport: "stdio" });
}

function jsonRpcError(status: number, code: number, message: string): Response {
	return Response.json({ jsonrpc: "2.0", error: { code, message } }, { status });
}

function normalizedAllowedHostname(value: string): string {
	if (value === "::1") return "[::1]";
	try {
		return new URL(`http://${value}`).hostname;
	} catch {
		return value;
	}
}

function validateHostHeader(request: Request, allowedHosts: ReadonlySet<string>): Response | undefined {
	const hostHeader = request.headers.get("host");
	if (!hostHeader) return jsonRpcError(403, -32000, "Missing Host header");

	let hostname: string;
	try {
		hostname = new URL(`http://${hostHeader}`).hostname;
	} catch {
		return jsonRpcError(403, -32000, `Invalid Host header: ${hostHeader}`);
	}
	if (!allowedHosts.has(hostname)) {
		return jsonRpcError(403, -32000, `Invalid Host: ${hostname}`);
	}
	return undefined;
}

function validateOriginHeader(request: Request, allowedHosts: ReadonlySet<string>): Response | undefined {
	const origin = request.headers.get("origin");
	if (origin === null) return undefined;
	try {
		const url = new URL(origin);
		if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === origin && allowedHosts.has(url.hostname)) {
			return undefined;
		}
	} catch {
		// Reject malformed origins, including opaque origins.
	}
	return jsonRpcError(403, -32000, "Origin is not allowed.");
}

async function withHttpLifecycle(
	request: Request,
	handle: () => Promise<Response>,
): Promise<Response> {
	const requestId = randomUUID();
	const startedAt = Date.now();
	const requestPath = new URL(request.url).pathname;
	let ended = false;

	logLifecycle("http_request_start", {
		request_id: requestId,
		method: request.method,
		path: requestPath,
	});

	const finish = (status: number, closedEarly: boolean): void => {
		if (ended) return;
		ended = true;
		logLifecycle("http_request_end", {
			request_id: requestId,
			method: request.method,
			path: requestPath,
			status,
			duration_ms: Date.now() - startedAt,
			closed_early: closedEarly,
		});
	};

	let response: Response;
	try {
		response = await handle();
	} catch (error) {
		logLifecycle("http_request_error", {
			request_id: requestId,
			name: error instanceof Error ? error.name : "unknown",
		});
		response = jsonRpcError(500, -32603, "Internal server error");
	}

	if (!response.body) {
		finish(response.status, false);
		return response;
	}

	const reader = response.body.getReader();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			// Give Bun bytes to flush before the first SDK event.
			if (request.method === "POST" && response.headers.get("content-type") === "text/event-stream") {
				controller.enqueue(SSE_OPEN_COMMENT);
			}
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					finish(response.status, false);
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				finish(response.status, true);
				controller.error(error);
			}
		},
		async cancel(reason) {
			finish(response.status, true);
			await reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

async function runHttp(opts: Options, createServer: () => Server): Promise<void> {
	if (opts.auth === "none" && opts.host !== "127.0.0.1" && opts.host !== "localhost" && opts.host !== "::1") {
		throw new Error("Refusing unauthenticated HTTP mode on a non-loopback bind address");
	}

	const allowedHosts = new Set(
		[opts.host, "localhost", "127.0.0.1", "::1", ...opts.allowedHosts].map(normalizedAllowedHostname),
	);
	const accessGuard = opts.auth === "cloudflare-access"
		? createCloudflareAccessGuard(parseCloudflareAccessConfig(process.env))
		: undefined;
	const mcp = createMcpHandler(createServer, {
		legacy: "reject",
		responseMode: "sse",
		keepAliveMs: 5_000,
		maxRequestBodySize: MAX_HTTP_BODY_BYTES,
	});

	const handleMcp = async (request: Request): Promise<Response> => {
		const authFailure = accessGuard ? await accessGuard(request) : undefined;
		return authFailure ?? mcp.fetch(request);
	};

	try {
		Bun.serve({
			hostname: opts.host,
			port: opts.port,
			maxRequestBodySize: MAX_HTTP_BODY_BYTES,
			fetch: (request) => withHttpLifecycle(request, async () => {
				const rejected = validateHostHeader(request, allowedHosts) ?? validateOriginHeader(request, allowedHosts);
				if (rejected) return rejected;

				const pathname = new URL(request.url).pathname;
				if (request.method === "GET" && pathname === "/healthz") {
					return Response.json({
						status: "ok",
						name: "pi-as-mcp",
						version: VERSION,
						uptime_seconds: Math.floor(process.uptime()),
					});
				}
				if (pathname === opts.path) return handleMcp(request);
				return new Response("Not Found", { status: 404 });
			}),
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to start server on ${opts.host}:${opts.port}: ${detail}`);
	}

	logLifecycle("connected", {
		transport: "http",
		host: opts.host,
		port: opts.port,
		path: opts.path,
		auth: opts.auth,
	});
}

async function main(): Promise<void> {
	installLifecycleDiagnostics();
	const opts = parseArgs(process.argv);
	logLifecycle("starting", { cwd: opts.cwd, tools: opts.tools.join(","), herdr_session: opts.herdrSession, transport: opts.transport });
	const herdr = await createHerdrRuntime(opts);
	const createServer = createPiMcpServerFactory(opts, herdr);
	if (opts.transport === "stdio") runStdio(createServer);
	else await runHttp(opts, createServer);
}

main().catch((error) => {
	process.stderr.write(`pi-as-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
