import { expect, test } from "bun:test";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import { BUN, CAPABILITIES_KEY, REVISION, VERSION_KEY, childEnv } from "./helpers";

async function openStdio() {
	const transport = new StdioClientTransport({
		command: BUN,
		args: ["src/index.ts", "--tools", "read"],
		env: childEnv(),
		stderr: "ignore",
	});
	await transport.start();
	let id = 0;
	return {
		async request(method: string, params: Record<string, unknown> = {}) {
			return this.rawRequest(method, {
				_meta: { [VERSION_KEY]: REVISION, [CAPABILITIES_KEY]: {} },
				...params,
			});
		},
		async rawRequest(method: string, params: Record<string, unknown> = {}) {
			const { promise, resolve, reject } = Promise.withResolvers<JSONRPCMessage>();
			transport.onmessage = resolve;
			transport.onerror = reject;
			await transport.send({ jsonrpc: "2.0", id: ++id, method, params });
			return promise;
		},
		close: () => transport.close(),
	};
}

test("modern stdio accepts independent requests without initialize", async () => {
	const stdio = await openStdio();
	try {
		expect(await stdio.request("tools/list")).toMatchObject({
			jsonrpc: "2.0", id: 1,
			result: {
				resultType: "complete", ttlMs: 0, cacheScope: "private",
				tools: [expect.objectContaining({ name: "read" })],
			},
		});
		expect(await stdio.request("server/discover")).toMatchObject({
			jsonrpc: "2.0", id: 2,
			result: {
				resultType: "complete", supportedVersions: [REVISION], capabilities: { tools: {} },
				ttlMs: 0, cacheScope: "private",
				_meta: { "io.modelcontextprotocol/serverInfo": { name: "pi-as-mcp" } },
			},
		});
		expect(await stdio.request("tools/list", { _meta: { [VERSION_KEY]: REVISION } })).toMatchObject({
			id: 3, error: { code: -32602 },
		});
		const future = "2099-01-01";
		for (const [index, method] of ["tools/list", "server/discover", "subscriptions/listen"].entries()) {
			expect(await stdio.request(method, {
				_meta: { [VERSION_KEY]: future, [CAPABILITIES_KEY]: {} },
				...(method === "subscriptions/listen" ? { notifications: {} } : {}),
			})).toMatchObject({
				id: 4 + index, error: { code: -32022, data: { requested: future, supported: [REVISION] } },
			});
		}
		expect(await stdio.request("tools/list")).toMatchObject({ id: 7, result: { resultType: "complete" } });
		expect(await stdio.request("tools/call", { name: "read", arguments: { path: false } })).toMatchObject({
			id: 8, result: { resultType: "complete", isError: true },
		});
	} finally {
		await stdio.close();
	}
});

test("modern stdio rejects legacy initialize and keeps serving modern requests", async () => {
	const stdio = await openStdio();
	try {
		expect(await stdio.rawRequest("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "legacy-probe", version: "0.0.0" },
		})).toMatchObject({
			jsonrpc: "2.0", id: 1,
			error: { code: -32022 },
		});
		expect(await stdio.request("tools/list")).toMatchObject({
			jsonrpc: "2.0", id: 2, result: { resultType: "complete" },
		});
	} finally {
		await stdio.close();
	}
});

test("the invocation limit rejects before tool execution and does not limit discovery", async () => {
	const stdio = await openStdio();
	try {
		const params = { name: "read", arguments: { path: false } };
		for (let i = 0; i < 60; i++) {
			expect(await stdio.request("tools/call", params)).toMatchObject({
				result: { isError: true, content: [{ text: expect.stringContaining("Invalid arguments") }] },
			});
		}
		expect(await stdio.request("tools/call", params)).toMatchObject({
			result: { isError: true, content: [{ text: expect.stringContaining("rate limit") }] },
		});
		expect(await stdio.request("tools/list")).toMatchObject({ result: { resultType: "complete" } });
	} finally {
		await stdio.close();
	}
});
