// Verify the optional synchronous-bash ceiling used by tunneled deployments.
// A long command must time out locally before a remote tunnel response deadline,
// while the shared MCP stdio server remains usable for the next request.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const assert = (cond, msg) => {
	if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
};

const text = (content) =>
	(content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-sync-cap-"));
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["dist/index.js", "--cwd", cwd],
		env: {
			...process.env,
			PI_MCP_BASH_MAX_SYNC_SECONDS: "0.2",
		},
		stderr: "inherit",
	});
	const client = new Client({ name: "sync-cap-smoke", version: "0.0.0" });

	try {
		await client.connect(transport);
		const instructions = client.getInstructions() ?? "";
		assert(instructions.includes("Synchronous bash calls are capped at 0.2 seconds"), `instructions: ${instructions}`);
		assert(instructions.includes("prefer tmux"), `missing detached-job guidance: ${instructions}`);

		const startedAt = Date.now();
		const timedOut = await client.callTool({
			name: "bash",
			arguments: { command: "sleep 2" },
		});
		const elapsedMs = Date.now() - startedAt;
		const timeoutText = text(timedOut.content);
		assert(timedOut.isError === true, `long bash unexpectedly succeeded: ${timeoutText}`);
		assert(/timed out after 0\.2 seconds/i.test(timeoutText), `unexpected timeout text: ${timeoutText}`);
		assert(elapsedMs < 1500, `local sync cap fired too slowly: ${elapsedMs}ms`);

		const followup = await client.callTool({
			name: "bash",
			arguments: { command: "printf 'survived-sync-cap'" },
		});
		const followupText = text(followup.content);
		assert(!followup.isError, `follow-up bash failed: ${followupText}`);
		assert(followupText.includes("survived-sync-cap"), `unexpected follow-up output: ${followupText}`);

		console.log(`PASS: sync cap fired after ${elapsedMs}ms and MCP remained usable`);
	} finally {
		await client.close().catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
