// Verify MCP request cancellation propagates into pi's bash tool: the spawned
// process tree must die when the client aborts the call. We run a command that
// appends a tick to a log every second for 5s, abort after ~1.5s, then (after
// the full 5s would have elapsed) read the log. Cancellation wired => few ticks;
// not wired => all 5 ticks from the detached process running to completion.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-cancel-"));
	const log = join(cwd, "ticks.txt");

	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["dist/index.js", "--cwd", cwd],
		stderr: "inherit",
	});
	const client = new Client({ name: "cancel-smoke", version: "0.0.0" });
	await client.connect(transport);

	const controller = new AbortController();
	// 5 ticks @ 1s. Bash detaches its own process group (non-win32), so without
	// cancellation the loop would outlive the client abort and keep writing.
	const command = `for i in 1 2 3 4 5; do echo "tick$i" >> "${log}"; sleep 1; done`;

	// Schedule the abort DURING the call, then await. Whether the client rejects
	// or resolves with an error result is incidental; the tick count is decisive.
	const abortTimer = setTimeout(() => controller.abort(), 1500);

	const start = Date.now();
	let outcome = "resolved";
	try {
		const r = await client.callTool(
			{ name: "bash", arguments: { command } },
			undefined,
			{ signal: controller.signal },
		);
		outcome = `resolved(isError=${r.isError ?? false})`;
	} catch (e) {
		outcome = `rejected(${e.name})`;
	}
	clearTimeout(abortTimer);
	console.log(`callTool ${outcome} after ${Date.now() - start}ms`);

	// Wait past the full loop duration so a runaway detached process would finish.
	await new Promise((r) => setTimeout(r, 7000));
	const contents = await readFile(log, "utf-8").catch(() => "");
	const ticks = contents.split("\n").filter((l) => l.startsWith("tick"));
	console.log(`ticks written: ${ticks.length} -> ${JSON.stringify(ticks)}`);

	// Grace: timing variance may allow 1 or 2 ticks before the abort lands. The
	// decisive signal is that we do NOT get all 5 (which means no cancellation).
	assertOrThrow(ticks.length < 5, `expected cancellation, but process ran to completion (${ticks.length} ticks)`);

	await client.close();
	await rm(cwd, { recursive: true, force: true });
	console.log("PASS: cancellation propagated to pi's bash (process tree killed)");
}

function assertOrThrow(cond, msg) {
	if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
