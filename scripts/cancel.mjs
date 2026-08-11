// Verify that MCP request cancellation reaches pi's bash tool and terminates the
// spawned process tree instead of merely abandoning the client-side request.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const assert = (cond, msg) => {
	if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
};

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-cancel-"));
	const log = join(cwd, "ticks.txt");
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["dist/index.js", "--cwd", cwd],
		stderr: "inherit",
	});
	const client = new Client({ name: "cancel-smoke", version: "0.0.0" });

	try {
		await client.connect(transport);
		const controller = new AbortController();
		const command = `for i in 1 2 3 4 5; do echo "tick$i" >> "${log}"; sleep 1; done`;
		const abortTimer = setTimeout(() => controller.abort(), 1500);
		const start = Date.now();
		let outcome = "resolved";

		try {
			const result = await client.callTool(
				{ name: "bash", arguments: { command } },
				undefined,
				{ signal: controller.signal },
			);
			outcome = `resolved(isError=${result.isError ?? false})`;
		} catch (error) {
			outcome = `rejected(${error instanceof Error ? error.name : String(error)})`;
		} finally {
			clearTimeout(abortTimer);
		}
		console.log(`callTool ${outcome} after ${Date.now() - start}ms`);

		// Cancellation must retire only this request. The shared MCP stdio server
		// must remain usable immediately afterward.
		const followup = await client.callTool({
			name: "bash",
			arguments: { command: "printf 'survived-cancel'" },
		});
		const followupText = (followup.content ?? [])
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		assert(!followup.isError, `follow-up bash failed after cancellation: ${followupText}`);
		assert(followupText.includes("survived-cancel"), `unexpected follow-up output: ${followupText}`);
		console.log("follow-up MCP bash succeeded after cancellation");

		// Wait beyond the command's uncancelled lifetime. A runaway detached process
		// would have written all five ticks by this point.
		await new Promise((resolve) => setTimeout(resolve, 7000));
		const contents = await readFile(log, "utf8").catch(() => "");
		const ticks = contents.split("\n").filter((line) => line.startsWith("tick"));
		console.log(`ticks written: ${ticks.length} -> ${JSON.stringify(ticks)}`);
		assert(ticks.length < 5, `expected cancellation, but process ran to completion (${ticks.length} ticks)`);
		console.log("PASS: cancellation killed only the bash process tree and the MCP server stayed usable");
	} finally {
		await client.close().catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
