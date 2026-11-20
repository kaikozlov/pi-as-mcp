import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { BUN, childEnv, connectStdio, contentText, firstText } from "./helpers";

describe("core MCP", () => {
	let cwd: string;
	let client: Client;

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "pi-mcp-"));
		await Bun.write(join(cwd, "pixel.png"), Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		));
		client = await connectStdio(["--cwd", cwd], {}, "test-core");
	});

	afterAll(async () => {
		await client?.close().catch(() => undefined);
		if (cwd) await rm(cwd, { recursive: true, force: true });
	});

	test("advertises every default tool as read-only for client compatibility", async () => {
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(["bash", "codemode", "edit", "read", "write"]);

		const read = tools.find((tool) => tool.name === "read");
		expect(read?.inputSchema.type).toBe("object");
		expect(read?.inputSchema.properties?.path).toBeDefined();

		for (const tool of tools) {
			expect(tool.annotations?.readOnlyHint).toBe(true);
		}
	});

	test("read returns text file contents", async () => {
		await Bun.write(join(cwd, "greet.txt"), "hello world\nsecond line\n");
		const result = await client.callTool({ name: "read", arguments: { path: "greet.txt" } });
		expect(firstText(result.content)).toContain("hello world");
		expect(firstText(result.content)).toContain("second line");
	});

	test("read returns image content", async () => {
		const result = await client.callTool({ name: "read", arguments: { path: "pixel.png" } });
		const image = (result.content as Array<any> | undefined)?.find((block) => block.type === "image");
		expect(image?.type).toBe("image");
		if (image?.type !== "image") throw new Error("missing image content");
		expect(image.mimeType).toBe("image/png");
		expect(image.data.length).toBeGreaterThan(0);
	});

	test("write creates a file", async () => {
		const result = await client.callTool({ name: "write", arguments: { path: "out.txt", content: "new content\n" } });
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(join(cwd, "out.txt")).text()).toBe("new content\n");
	});

	test("edit applies an exact replacement", async () => {
		await Bun.write(join(cwd, "edit.txt"), "hello world\nsecond line\n");
		const result = await client.callTool({
			name: "edit",
			arguments: { path: "edit.txt", edits: [{ oldText: "hello world", newText: "hello mars" }] },
		});
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(join(cwd, "edit.txt")).text()).toBe("hello mars\nsecond line\n");
	});

	test("bash runs in the configured cwd", async () => {
		const result = await client.callTool({ name: "bash", arguments: { command: "printf 'from-bash\\n'; pwd" } });
		expect(result.isError).not.toBe(true);
		expect(firstText(result.content)).toContain("from-bash");
		expect(firstText(result.content)).toContain(cwd);
	});

	test("bash non-zero exit is an MCP tool error", async () => {
		const result = await client.callTool({ name: "bash", arguments: { command: "exit 3" } });
		expect(result.isError).toBe(true);
		expect(firstText(result.content)).toMatch(/exited with code 3/i);
	});

	test("invalid arguments are rejected before tool execution", async () => {
		const result = await client.callTool({ name: "read", arguments: { path: 123 } });
		expect(result.isError).toBe(true);
		expect(firstText(result.content)).toMatch(/invalid arguments/i);
	});

	test("an unknown tool is a JSON-RPC invalid params error", async () => {
		await expect(client.callTool({ name: "not-a-tool" })).rejects.toMatchObject({ code: -32602 });
	});

	test("tool implementation errors remain MCP tool errors", async () => {
		const result = await client.callTool({
			name: "edit",
			arguments: { path: "missing.txt", edits: [{ oldText: "x", newText: "y" }] },
		});
		expect(result.isError).toBe(true);
	});

	test("--tools exposes only the requested subset", async () => {
		const subset = await connectStdio(["--cwd", cwd, "--tools", "read,bash"], {}, "test-core-subset");
		try {
			const { tools } = await subset.listTools();
			expect(tools.map((tool) => tool.name)).toEqual(["read", "bash"]);
			for (const tool of tools) {
				expect(tool.description).not.toContain(`tools.${tool.name}(args)`);
			}
		} finally {
			await subset.close().catch(() => undefined);
		}
	});

	test("codemode can call only enabled tools and validates their arguments", async () => {
		await Bun.write(join(cwd, "codemode-read.txt"), "read through codemode");
		const subset = await connectStdio(["--cwd", cwd, "--tools", "read,codemode"]);
		try {
			const result = await subset.callTool({
				name: "codemode",
				arguments: { code: `
					if ("write" in tools || "codemode" in tools) throw new Error("Unexpected nested tool");
					try {
						await tools.read({ path: false });
						throw new Error("Invalid read arguments accepted");
					} catch (error) {
						if (!error.message.includes("Invalid arguments for read")) throw error;
					}
					store("example", "private");
					return await tools.read({ path: "codemode-read.txt" });
				` },
			});
			expect(result.isError, contentText(result.content)).not.toBe(true);
			expect(contentText(result.content)).toContain("read through codemode");
			const next = await subset.callTool({
				name: "codemode",
				arguments: { code: `return load("example") ?? "store is empty";` },
			});
			expect(contentText(next.content)).toContain("store is empty");
		} finally {
			await subset.close();
		}
	});

	test("PI_MCP_CWD and PI_MCP_TOOLS configure the server", async () => {
		await Bun.write(join(cwd, "env.txt"), "configured by env\n");
		const envClient = await connectStdio([], {
			PI_MCP_CWD: cwd,
			PI_MCP_TOOLS: "read",
		}, "test-core-env");
		try {
			const { tools } = await envClient.listTools();
			expect(tools.map((tool) => tool.name)).toEqual(["read"]);
			const result = await envClient.callTool({ name: "read", arguments: { path: "env.txt" } });
			expect(firstText(result.content)).toContain("configured by env");
		} finally {
			await envClient.close().catch(() => undefined);
		}
	});

	test("Herdr startup failure degrades only subagent tools", async () => {
		const degraded = await connectStdio(["--cwd", cwd], {
			PI_MCP_TOOLS: "read,agent",
			PI_MCP_HERDR_SESSION: "pi-as-mcp-test",
			PI_MCP_HERDR_BIN: join(cwd, "missing-herdr"),
		}, "test-core-degraded");
		try {
			const { tools } = await degraded.listTools();
			expect(tools.map((tool) => tool.name)).toEqual(["read"]);
		} finally {
			await degraded.close().catch(() => undefined);
		}
	});

	test("agent cannot be enabled without a dedicated Herdr session", () => {
		const result = Bun.spawnSync([BUN, "src/index.ts", "--cwd", cwd, "--tools", "agent"], {
			env: childEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toMatch(/require(?:s)? --herdr-session/i);
	});

	test("default Herdr session is rejected", () => {
		const result = Bun.spawnSync([BUN, "src/index.ts", "--cwd", cwd, "--herdr-session", "default"], {
			env: childEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toMatch(/dedicated named herdr session/i);
	});

	test("CLI --version matches package.json", async () => {
		const pkg = await Bun.file("package.json").json();
		const result = Bun.spawnSync([BUN, "src/index.ts", "--version"], {
			env: childEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe(pkg.version);
	});

	test("CLI rejects an unknown argument", () => {
		const result = Bun.spawnSync([BUN, "src/index.ts", "--wat"], {
			env: childEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toMatch(/unknown argument/i);
	});

	test("CLI rejects a nonexistent cwd", () => {
		const result = Bun.spawnSync([BUN, "src/index.ts", "--cwd", join(cwd, "does-not-exist")], {
			env: childEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toMatch(/cannot access working directory/i);
	});
});
