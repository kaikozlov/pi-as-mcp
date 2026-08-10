// Protocol-level smoke test for pi-as-mcp. Exercises all four tools, schema
// validation, CLI/env configuration, image content, and common error paths.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const assert = (cond, msg) => {
	if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
};

const text = (content) => {
	const block = content?.[0];
	return block?.type === "text" ? block.text : undefined;
};

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));

async function connect(args, env) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["dist/index.js", ...args],
		env,
		stderr: "inherit",
	});
	const client = new Client({ name: "smoke", version: "0.0.0" });
	await client.connect(transport);
	return client;
}

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-"));
	let failures = 0;
	const clients = [];
	const step = async (name, fn) => {
		try {
			await fn();
			console.log(`  ok  ${name}`);
		} catch (error) {
			failures++;
			console.error(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	try {
		await writeFile(join(cwd, "greet.txt"), "hello world\nsecond line\n");
		// 1x1 transparent PNG.
		await writeFile(
			join(cwd, "pixel.png"),
			Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
		);

		const client = await connect(["--cwd", cwd]);
		clients.push(client);

		await step("tools/list advertises the four pi tools and MCP hints", async () => {
			const { tools } = await client.listTools();
			const names = tools.map((tool) => tool.name).sort();
			assert(JSON.stringify(names) === JSON.stringify(["bash", "edit", "read", "write"]), `got ${names}`);
			const read = tools.find((tool) => tool.name === "read");
			const bash = tools.find((tool) => tool.name === "bash");
			assert(read?.inputSchema.type === "object", `read schema type=${read?.inputSchema?.type}`);
			assert(!!read?.inputSchema.properties?.path, "read schema missing properties.path");
			assert(read?.annotations?.readOnlyHint === true, "read missing readOnlyHint");
			assert(read?.annotations?.openWorldHint === false, "read should be closed-world");
			assert(bash?.annotations?.openWorldHint === true, "bash should be open-world");
		});

		await step("read returns text file contents", async () => {
			const result = await client.callTool({ name: "read", arguments: { path: "greet.txt" } });
			const output = text(result.content);
			assert(output?.includes("hello world") && output.includes("second line"), `got: ${output}`);
		});

		await step("read returns image content", async () => {
			const result = await client.callTool({ name: "read", arguments: { path: "pixel.png" } });
			const image = result.content?.find((block) => block.type === "image");
			assert(image?.type === "image", `content types=${result.content?.map((block) => block.type)}`);
			assert(image.mimeType === "image/png", `mimeType=${image.mimeType}`);
			assert(typeof image.data === "string" && image.data.length > 0, "image data missing");
		});

		await step("write creates a file", async () => {
			const result = await client.callTool({ name: "write", arguments: { path: "out.txt", content: "new content\n" } });
			assert(result.isError !== true, `result: ${text(result.content)}`);
			const onDisk = await readFile(join(cwd, "out.txt"), "utf8");
			assert(onDisk === "new content\n", `disk: ${JSON.stringify(onDisk)}`);
		});

		await step("edit applies an exact replacement", async () => {
			const result = await client.callTool({
				name: "edit",
				arguments: { path: "greet.txt", edits: [{ oldText: "hello world", newText: "hello mars" }] },
			});
			assert(result.isError !== true, `result: ${text(result.content)}`);
			const onDisk = await readFile(join(cwd, "greet.txt"), "utf8");
			assert(onDisk === "hello mars\nsecond line\n", `disk: ${JSON.stringify(onDisk)}`);
		});

		await step("bash runs in the configured cwd", async () => {
			const result = await client.callTool({ name: "bash", arguments: { command: "printf 'from-bash\\n'; pwd" } });
			const output = text(result.content);
			assert(result.isError !== true, `bash flagged as error: ${output}`);
			assert(output?.includes("from-bash"), `output: ${output}`);
			assert(output?.includes(cwd), `pwd not in output: ${output}`);
		});

		await step("bash non-zero exit is an MCP tool error", async () => {
			const result = await client.callTool({ name: "bash", arguments: { command: "exit 3" } });
			assert(result.isError === true, `isError=${result.isError}`);
			assert(/exited with code 3/i.test(text(result.content) ?? ""), `message: ${text(result.content)}`);
		});

		await step("invalid arguments are rejected before tool execution", async () => {
			const result = await client.callTool({ name: "read", arguments: { path: 123 } });
			assert(result.isError === true, `isError=${result.isError}`);
			assert(/invalid arguments/i.test(text(result.content) ?? ""), `message: ${text(result.content)}`);
		});

		await step("tool implementation errors remain MCP tool errors", async () => {
			const result = await client.callTool({
				name: "edit",
				arguments: { path: "missing.txt", edits: [{ oldText: "x", newText: "y" }] },
			});
			assert(result.isError === true, `isError=${result.isError}`);
		});

		await step("--tools exposes only the requested subset", async () => {
			const subset = await connect(["--cwd", cwd, "--tools", "read,bash"]);
			clients.push(subset);
			const { tools } = await subset.listTools();
			assert(JSON.stringify(tools.map((tool) => tool.name)) === JSON.stringify(["read", "bash"]), `got ${tools.map((tool) => tool.name)}`);
		});

		await step("PI_MCP_CWD and PI_MCP_TOOLS configure the server", async () => {
			const envClient = await connect([], {
				...cleanEnv(),
				PI_MCP_CWD: cwd,
				PI_MCP_TOOLS: "read",
			});
			clients.push(envClient);
			const { tools } = await envClient.listTools();
			assert(tools.length === 1 && tools[0]?.name === "read", `got ${tools.map((tool) => tool.name)}`);
			const result = await envClient.callTool({ name: "read", arguments: { path: "greet.txt" } });
			assert(text(result.content)?.includes("hello mars"), `output: ${text(result.content)}`);
		});

		await step("CLI --version matches package.json", async () => {
			const pkg = JSON.parse(await readFile("package.json", "utf8"));
			const result = spawnSync(process.execPath, ["dist/index.js", "--version"], { encoding: "utf8" });
			assert(result.status === 0, `status=${result.status}, stderr=${result.stderr}`);
			assert(result.stdout.trim() === pkg.version, `stdout=${JSON.stringify(result.stdout)}`);
		});

		await step("CLI rejects an unknown argument", async () => {
			const result = spawnSync(process.execPath, ["dist/index.js", "--wat"], { encoding: "utf8" });
			assert(result.status !== 0, "unknown argument unexpectedly succeeded");
			assert(/unknown argument/i.test(result.stderr), `stderr=${result.stderr}`);
		});

		await step("CLI rejects a nonexistent cwd", async () => {
			const missing = join(cwd, "does-not-exist");
			const result = spawnSync(process.execPath, ["dist/index.js", "--cwd", missing], { encoding: "utf8" });
			assert(result.status !== 0, "nonexistent cwd unexpectedly succeeded");
			assert(/cannot access working directory/i.test(result.stderr), `stderr=${result.stderr}`);
		});
	} finally {
		for (const client of clients.reverse()) {
			await client.close().catch(() => undefined);
		}
		await rm(cwd, { recursive: true, force: true });
	}

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
