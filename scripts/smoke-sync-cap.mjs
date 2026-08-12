// Verify tunnel-safe managed bash behavior.
// Long commands must yield locally before a remote response deadline, continue
// running across an MCP server restart, and remain pollable by session ID.
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

async function connect(cwd) {
	const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_MCP_")));
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["dist/index.js", "--cwd", cwd],
		env: {
			...baseEnv,
			PI_MCP_BASH_MAX_SYNC_SECONDS: "0.2",
		},
		stderr: "inherit",
	});
	const client = new Client({ name: "managed-bash-smoke", version: "0.0.0" });
	await client.connect(transport);
	return { client, transport };
}

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-managed-bash-"));
	let first;
	let second;

	try {
		first = await connect(cwd);
		const instructions = first.client.getInstructions() ?? "";
		assert(instructions.includes("automatically yields after 0.2 seconds"), `instructions: ${instructions}`);
		assert(instructions.includes("tmux is not required"), `missing managed-job guidance: ${instructions}`);

		const startedAt = Date.now();
		const yielded = await first.client.callTool({
			name: "bash",
			arguments: { command: "printf 'begin\\n'; sleep 0.8; printf 'done\\n'" },
		});
		const elapsedMs = Date.now() - startedAt;
		const yieldedText = text(yielded.content);
		assert(!yielded.isError, `long bash unexpectedly failed: ${yieldedText}`);
		assert(elapsedMs < 1200, `managed bash yielded too slowly: ${elapsedMs}ms`);
		assert(yieldedText.includes("still running after 0.2 seconds"), `missing yield status: ${yieldedText}`);
		const match = yieldedText.match(/session_id=([0-9a-f-]{36})/i);
		assert(match, `missing session id: ${yieldedText}`);
		const sessionId = match[1];
		console.log(`yielded after ${elapsedMs}ms with session ${sessionId}`);

		// Simulate the tunnel/MCP subprocess being restarted after the tool call
		// has already returned. The detached command must remain recoverable from
		// its durable job files rather than being owned by the stdio request.
		await first.client.close();
		first = undefined;
		await new Promise((resolve) => setTimeout(resolve, 900));

		second = await connect(cwd);
		const completed = await second.client.callTool({
			name: "bash",
			arguments: { command: `:session ${sessionId}` },
		});
		const completedText = text(completed.content);
		assert(!completed.isError, `poll after restart failed: ${completedText}`);
		assert(completedText.includes("done"), `missing final command output: ${completedText}`);
		assert(completedText.includes("completed with exit code 0"), `missing completion status: ${completedText}`);

		const timeoutStarted = Date.now();
		const timedOut = await second.client.callTool({
			name: "bash",
			arguments: { command: "sleep 2", timeout: 0.05 },
		});
		const timeoutElapsed = Date.now() - timeoutStarted;
		const timeoutText = text(timedOut.content);
		assert(timedOut.isError === true, `hard timeout unexpectedly succeeded: ${timeoutText}`);
		assert(/timed out after 0\.05 seconds/i.test(timeoutText), `unexpected timeout text: ${timeoutText}`);
		assert(timeoutElapsed < 1200, `hard timeout fired too slowly: ${timeoutElapsed}ms`);

		const followup = await second.client.callTool({
			name: "bash",
			arguments: { command: "printf 'survived-managed-bash'" },
		});
		const followupText = text(followup.content);
		assert(!followup.isError, `follow-up bash failed: ${followupText}`);
		assert(followupText.includes("survived-managed-bash"), `unexpected follow-up output: ${followupText}`);

		console.log("PASS: managed bash yields, survives server restart, polls to completion, and preserves hard timeouts");
	} finally {
		await first?.client.close().catch(() => undefined);
		await second?.client.close().catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
