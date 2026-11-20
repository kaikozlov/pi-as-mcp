import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { BUN, CAPABILITIES_KEY, REVISION, VERSION_KEY, childEnv, contentText, freePort, modernClient, stopProcess, waitForHealth } from "./helpers";

setDefaultTimeout(15_000);

async function readRpc(response: Response): Promise<unknown> {
	const text = await response.text();
	if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
		const frame = text.split("\n").find((line) => line.startsWith("data: "));
		if (!frame) throw new Error("No JSON-RPC event in the response.");
		return JSON.parse(frame.slice(6));
	}
	return JSON.parse(text);
}

describe("Streamable HTTP transport", () => {
	let cwd: string;
	let ticksPath: string;
	let logPath: string;
	let port: number;
	let base: string;
	let server: Bun.Subprocess;
	let client: Client;

	function modernPost(
		method: string,
		params: Record<string, unknown> = {},
		overrides: Record<string, string | null> = {},
		signal?: AbortSignal,
	): Promise<Response> {
		const headers = new Headers({
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-protocol-version": REVISION,
			"mcp-method": method,
		});
		if (typeof params.name === "string") headers.set("mcp-name", params.name);
		for (const [name, value] of Object.entries(overrides)) {
			if (value === null) headers.delete(name);
			else headers.set(name, value);
		}
		return fetch(`${base}/mcp`, {
			method: "POST",
			headers,
			signal,
			body: JSON.stringify({
				jsonrpc: "2.0", id: "modern", method,
				params: { _meta: { [VERSION_KEY]: REVISION, [CAPABILITIES_KEY]: {} }, ...params },
			}),
		});
	}

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "pi-mcp-http-"));
		ticksPath = join(cwd, "ticks.txt");
		logPath = join(cwd, "lifecycle.jsonl");
		port = await freePort();
		base = `http://127.0.0.1:${port}`;

		server = Bun.spawn([
			BUN,
			"src/index.ts",
			"--transport", "http",
			"--auth", "none",
			"--host", "127.0.0.1",
			"--port", String(port),
			"--cwd", cwd,
		], {
			env: childEnv({ PI_MCP_LOG_FILE: logPath }),
			stdout: "ignore",
			stderr: "inherit",
		});

		await waitForHealth(`${base}/healthz`, server);

		client = modernClient("test-http");
		await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
	});

	afterAll(async () => {
		await client?.close().catch(() => undefined);
		await stopProcess(server);
		if (cwd) await rm(cwd, { recursive: true, force: true });
	});

	test("health endpoint reports ready", async () => {
		const response = await fetch(`${base}/healthz`);
		expect(response.ok).toBe(true);
		expect(await response.json()).toMatchObject({
			status: "ok",
			name: "pi-as-mcp",
		});
	});

	test("validates the Origin header before serving", async () => {
		for (const origin of ["https://unlisted.example", "null", `${base}/not-an-origin`]) {
			const response = await modernPost("tools/list", {}, { origin });
			expect(response.status).toBe(403);
			await response.body?.cancel();
		}

		const allowed = await modernPost("tools/list", {}, { origin: base });
		expect(allowed.status).toBe(200);
		await allowed.text();
	});

	test("serves modern calls without initialize or a protocol session", async () => {
		const response = await modernPost("tools/list");
		expect(response.status).toBe(200);
		expect(response.headers.has("mcp-session-id")).toBe(false);
		const listed = await readRpc(response);
		expect(listed).toMatchObject({
			jsonrpc: "2.0", id: "modern",
			result: {
				resultType: "complete", ttlMs: 0, cacheScope: "private",
				tools: [
					expect.objectContaining({ name: "read" }),
					expect.objectContaining({ name: "write" }),
					expect.objectContaining({ name: "edit" }),
					expect.objectContaining({ name: "bash" }),
				],
			},
		});
		expect(await readRpc(await modernPost("tools/list"))).toEqual(listed);
		expect(await readRpc(await modernPost("server/discover"))).toMatchObject({
			result: {
				resultType: "complete", supportedVersions: [REVISION], capabilities: { tools: {} },
				ttlMs: 0, cacheScope: "private",
				_meta: { "io.modelcontextprotocol/serverInfo": { name: "pi-as-mcp" } },
			},
		});

		const exactText = "first\r\n\u001b[31msecond\n";
		await Bun.write(join(cwd, "modern.txt"), exactText);
		expect(await readRpc(await modernPost("tools/call", {
			name: "read", arguments: { path: "modern.txt" },
		}, { "mcp-name": "=?base64?cmVhZA==?=" }))).toMatchObject({
			result: { resultType: "complete", content: [{ type: "text", text: exactText }] },
		});
	});

	test("rejects malformed modern requests with typed errors", async () => {
		const future = "2099-01-01";
		const expectError = async (response: Response, status: number, code: number, data?: object) => {
			expect(response.status).toBe(status);
			expect(response.headers.has("mcp-session-id")).toBe(false);
			expect(await response.json()).toMatchObject({
				jsonrpc: "2.0", id: "modern", error: { code, ...(data && { data }) },
			});
		};

		await expectError(await modernPost("tools/list", {}, { "mcp-method": "tools/call" }), 400, -32020);
		await expectError(await modernPost("tools/list", {}, { "mcp-protocol-version": null }), 400, -32020);
		await expectError(await modernPost("tools/call", { name: "read" }, { "mcp-name": null }), 400, -32020);
		await expectError(await modernPost("tools/list", { _meta: { [VERSION_KEY]: REVISION } }), 400, -32602);

		const legacyInitialize = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0", id: "modern", method: "initialize",
				params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy-probe", version: "0.0.0" } },
			}),
		});
		expect(legacyInitialize.status).toBe(400);
		expect(legacyInitialize.headers.has("mcp-session-id")).toBe(false);
		expect(await legacyInitialize.json()).toMatchObject({ jsonrpc: "2.0", id: "modern", error: { code: -32022 } });

		await expectError(await modernPost("tools/list", {
			_meta: { [VERSION_KEY]: future, [CAPABILITIES_KEY]: {} },
		}, { "mcp-protocol-version": future }), 400, -32022, { supported: [REVISION], requested: future });
		await expectError(await modernPost("unknown/method"), 404, -32601);
		expect(await readRpc(await modernPost("tools/call", { name: "not-a-tool" }))).toMatchObject({
			error: { code: -32602 },
		});
		expect(await readRpc(await modernPost("tools/call", { name: "read", arguments: { path: false } }))).toMatchObject({
			result: { resultType: "complete", isError: true },
		});
		expect((await client.listTools()).tools).toHaveLength(4);
	});

	test("rejects GET and DELETE with 405 regardless of legacy hints", async () => {
		for (const withLegacyHints of [true, false]) {
			for (const method of ["GET", "DELETE"]) {
				const response = await fetch(`${base}/mcp`, {
					method,
					headers: withLegacyHints
						? { accept: "text/event-stream", "mcp-protocol-version": REVISION, "mcp-session-id": "legacy-session-id" }
						: undefined,
				});
				expect(response.status).toBe(405);
				await response.body?.cancel();
			}
		}
		expect((await client.listTools()).tools).toHaveLength(4);
	});

	test("a second server cannot bind the occupied port", async () => {
		const conflict = Bun.spawn([
			BUN,
			"src/index.ts",
			"--transport", "http",
			"--auth", "none",
			"--host", "127.0.0.1",
			"--port", String(port),
			"--cwd", cwd,
		], {
			env: childEnv(),
			stdout: "ignore",
			stderr: "pipe",
		});

		const [exitCode, stderr] = await Promise.all([
			conflict.exited,
			new Response(conflict.stderr).text(),
		]);

		expect(exitCode).not.toBe(0);
		expect(stderr).toMatch(/EADDRINUSE|port .*in use/i);
	});

	test("exposes the four core tools over HTTP", async () => {
		const listed = await client.listTools();
		expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "read", "write"]);

		const result = await client.callTool({
			name: "bash",
			arguments: { command: "printf 'http-ok'" },
		});
		expect(result.isError).not.toBe(true);
		expect(contentText(result.content)).toContain("http-ok");
	});

	test("HTTP cancellation kills only the active bash request", async () => {
		const controller = new AbortController();
		const command = `for i in 1 2 3 4 5; do echo "tick$i" >> "${ticksPath}"; sleep 1; done`;
		const abortTimer = setTimeout(() => controller.abort(), 1500);

		try {
			await expect(
				client.callTool(
					{ name: "bash", arguments: { command } },
					{ signal: controller.signal },
				),
			).rejects.toBeDefined();
		} finally {
			clearTimeout(abortTimer);
		}

		const followup = await client.callTool({
			name: "bash",
			arguments: { command: "printf 'survived-http-cancel'" },
		});
		expect(followup.isError).not.toBe(true);
		expect(contentText(followup.content)).toContain("survived-http-cancel");

		await Bun.sleep(5500);
		const contents = await Bun.file(ticksPath).text().catch(() => "");
		const ticks = contents.split("\n").filter((line) => line.startsWith("tick"));
		expect(ticks.length).toBeLessThan(5);
	}, 10_000);

	test("closing a modern HTTP stream cancels its in-flight call", async () => {
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		const watcher = watch(cwd, (_, filename) => {
			if (filename === "modern-started") started.resolve();
			if (filename !== "lifecycle.jsonl") return;
			const events = readFileSync(logPath, "utf8");
			if (events.split("\n").some((line) =>
				line.includes('"event":"tool_call_end"') &&
				line.includes('"request_id":"modern"') &&
				line.includes('"aborted":true')
			)) cancelled.resolve();
		});
		try {
			const response = await modernPost("tools/call", {
				name: "bash", arguments: { command: "touch modern-started; sleep 30; touch modern-finished" },
			}, {}, AbortSignal.timeout(8_000));
			expect(response.headers.get("content-type")).toBe("text/event-stream");
			await started.promise;
			await response.body!.cancel();
			await cancelled.promise;
			expect(await Bun.file(join(cwd, "modern-finished")).exists()).toBe(false);
			expect(await readRpc(await modernPost("tools/call", {
				name: "bash", arguments: { command: "printf 'survived-disconnect'" },
			}))).toMatchObject({
				result: { content: [{ type: "text", text: "survived-disconnect" }] },
			});
		} finally {
			watcher.close();
		}
	});
});
