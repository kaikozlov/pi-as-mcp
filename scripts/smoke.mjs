// End-to-end smoke test: spawn the built MCP server over stdio and exercise all
// four tools through the real MCP protocol (initialize -> tools/list -> tools/call).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const assert = (cond, msg) => {
	if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
};

function text(content) {
	const block = content?.[0];
	return block?.type === "text" ? block.text : undefined;
}

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-"));
	await writeFile(join(cwd, "greet.txt"), "hello world\nsecond line\n");

	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["dist/index.js", "--cwd", cwd],
		stderr: "inherit",
	});
	const client = new Client({ name: "smoke", version: "0.0.0" });
	await client.connect(transport);

	let failures = 0;
	const step = async (name, fn) => {
		try {
			await fn();
			console.log(`  ok  ${name}`);
		} catch (e) {
			failures++;
			console.error(`FAIL  ${name}: ${e.message}`);
		}
	};

	// 1. tools/list
	await step("tools/list advertises read, write, edit, bash", async () => {
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		assert(JSON.stringify(names) === JSON.stringify(["bash", "edit", "read", "write"]), `got ${names}`);
		// inputSchema must be a clean JSON-Schema object (no symbol junk).
		const read = tools.find((t) => t.name === "read");
		assert(read.inputSchema.type === "object", `read inputSchema.type=${read.inputSchema?.type}`);
		assert(!!read.inputSchema.properties?.path, "read inputSchema missing properties.path");
		assert(Array.isArray(read.inputSchema.required), "read inputSchema missing required");
		assert(read.description?.length > 0, "read missing description");
		assert(read.annotations?.readOnlyHint === true, "read missing readOnlyHint");
	});

	// 2. read
	await step("read returns file contents", async () => {
		const r = await client.callTool({ name: "read", arguments: { path: "greet.txt" } });
		const t = text(r.content);
		assert(t?.includes("hello world") && t.includes("second line"), `got: ${t}`);
	});

	// 3. write
	await step("write creates a file", async () => {
		const r = await client.callTool({ name: "write", arguments: { path: "out.txt", content: "new content\n" } });
		const t = text(r.content);
		assert(/wrote|created|success/i.test(t ?? ""), `result: ${t}`);
		const onDisk = await readFile(join(cwd, "out.txt"), "utf-8");
		assert(onDisk === "new content\n", `disk: ${JSON.stringify(onDisk)}`);
	});

	// 4. edit
	await step("edit applies a targeted replacement", async () => {
		const r = await client.callTool({
			name: "edit",
			arguments: { path: "greet.txt", edits: [{ oldText: "hello world", newText: "hello mars" }] },
		});
		const t = text(r.content);
		assert(/replaced|success/i.test(t ?? ""), `result: ${t}`);
		const onDisk = await readFile(join(cwd, "greet.txt"), "utf-8");
		assert(onDisk === "hello mars\nsecond line\n", `disk: ${JSON.stringify(onDisk)}`);
	});

	// 5. bash (success)
	await step("bash runs a command and returns stdout", async () => {
		const r = await client.callTool({ name: "bash", arguments: { command: "echo from-bash && pwd" } });
		const t = text(r.content);
		assert(t?.includes("from-bash"), `output: ${t}`);
		assert(t?.includes(cwd), `pwd not in output: ${t}`);
		assert(r.isError !== true, "bash flagged as error");
	});

	// 6. bash (failure -> isError)
	await step("bash non-zero exit surfaces as isError", async () => {
		const r = await client.callTool({ name: "bash", arguments: { command: "exit 3" } });
		assert(r.isError === true, `isError=${r.isError}`);
		const t = text(r.content);
		assert(/exited with code 3/i.test(t ?? ""), `message: ${t}`);
	});

	// 7. edit error path (nonexistent file) -> isError, not a crash
	await step("edit on missing file returns isError", async () => {
		const r = await client.callTool({
			name: "edit",
			arguments: { path: "nope.txt", edits: [{ oldText: "x", newText: "y" }] },
		});
		assert(r.isError === true, `isError=${r.isError}`);
	});

	await client.close();
	await rm(cwd, { recursive: true, force: true });

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
