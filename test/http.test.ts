import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BUN, childEnv, contentText, freePort, stopProcess, waitForHealth } from "./helpers";
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";

setDefaultTimeout(15_000);

describe("Streamable HTTP transport", () => {
	let cwd: string;
	let ticksPath: string;
	let port: number;
	let base: string;
	let server: Bun.Subprocess;
	let client: Client;

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "pi-mcp-http-"));
		ticksPath = join(cwd, "ticks.txt");
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
			env: childEnv(),
			stdout: "ignore",
			stderr: "inherit",
		});

		await waitForHealth(`${base}/healthz`, server);

		client = new MCPClient({ name: "test-http", version: "0.0.0" });
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
					undefined,
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
});
