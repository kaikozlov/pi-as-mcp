import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectStdio, contentText } from "./helpers";

async function connect(cwd: string): Promise<Client> {
	return connectStdio(
		["--cwd", cwd],
		{ PI_MCP_BASH_MAX_SYNC_SECONDS: "0.2" },
		"test-managed-bash",
	);
}

test("managed bash yields, survives server restart, polls, and preserves hard timeouts", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-managed-bash-"));
	let first: Client | undefined;
	let second: Client | undefined;

	try {
		first = await connect(cwd);
		const instructions = first.getInstructions() ?? "";
		expect(instructions).toContain("automatically yields after 0.2 seconds");
		expect(instructions).toContain("tmux is not required");

		const startedAt = performance.now();
		const yielded = await first.callTool({
			name: "bash",
			arguments: { command: "printf 'begin\\n'; sleep 0.8; printf 'done\\n'" },
		});
		const elapsedMs = performance.now() - startedAt;
		const yieldedText = contentText(yielded.content);

		expect(yielded.isError).not.toBe(true);
		expect(elapsedMs).toBeLessThan(1200);
		expect(yieldedText).toContain("still running after 0.2 seconds");

		const sessionId = yieldedText.match(/session_id=([0-9a-f-]{36})/i)?.[1];
		expect(sessionId).toBeDefined();
		if (!sessionId) throw new Error("managed bash did not return a session id");

		await first.close();
		first = undefined;
		await Bun.sleep(900);

		second = await connect(cwd);
		const completed = await second.callTool({
			name: "bash",
			arguments: { command: `:session ${sessionId}` },
		});
		const completedText = contentText(completed.content);
		expect(completed.isError).not.toBe(true);
		expect(completedText).toContain("done");
		expect(completedText).toContain("completed with exit code 0");

		const timeoutStarted = performance.now();
		const timedOut = await second.callTool({
			name: "bash",
			arguments: { command: "sleep 2", timeout: 0.05 },
		});
		const timeoutElapsed = performance.now() - timeoutStarted;
		expect(timedOut.isError).toBe(true);
		expect(contentText(timedOut.content)).toMatch(/timed out after 0\.05 seconds/i);
		expect(timeoutElapsed).toBeLessThan(1200);

		const followup = await second.callTool({
			name: "bash",
			arguments: { command: "printf 'survived-managed-bash'" },
		});
		expect(followup.isError).not.toBe(true);
		expect(contentText(followup.content)).toContain("survived-managed-bash");
	} finally {
		await first?.close().catch(() => undefined);
		await second?.close().catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}, 10_000);
