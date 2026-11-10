import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectStdio, contentText } from "./helpers";

test("MCP cancellation kills the bash process tree without killing the server", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-cancel-"));
	const log = join(cwd, "ticks.txt");
	const client = await connectStdio(["--cwd", cwd], {}, "test-cancel");

	try {
		const controller = new AbortController();
		const command = `for i in 1 2 3 4 5; do echo "tick$i" >> "${log}"; sleep 1; done`;
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
			arguments: { command: "printf 'survived-cancel'" },
		});
		expect(followup.isError).not.toBe(true);
		expect(contentText(followup.content)).toContain("survived-cancel");

		await Bun.sleep(7000);
		const contents = await Bun.file(log).text().catch(() => "");
		const ticks = contents.split("\n").filter((line) => line.startsWith("tick"));
		expect(ticks.length).toBeLessThan(5);
	} finally {
		await client.close().catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}, 12_000);
