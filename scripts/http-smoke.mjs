import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_MCP_")));

const assert = (cond, msg) => {
	if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
};

async function freePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise((resolve) => server.close(resolve));
	if (!port) throw new Error("failed to allocate test port");
	return port;
}

async function waitForHealth(url, child) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`HTTP server exited early with ${child.exitCode}`);
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {
			// startup race
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("timed out waiting for HTTP server");
}

function resultText(result) {
	return (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-http-"));
	const ticksPath = join(cwd, "ticks.txt");
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const child = spawn(process.execPath, [
		"dist/index.js",
		"--transport", "http",
		"--auth", "none",
		"--host", "127.0.0.1",
		"--port", String(port),
		"--cwd", cwd,
	], {
		env: cleanEnv,
		stdio: ["ignore", "pipe", "inherit"],
	});
	const client = new Client({ name: "http-smoke", version: "0.0.0" });

	try {
		await waitForHealth(`${base}/healthz`, child);
		const health = await (await fetch(`${base}/healthz`)).json();
		assert(health.status === "ok", `unexpected health response: ${JSON.stringify(health)}`);

		// Express 5 passes bind errors to app.listen's callback. A previous
		// integration ignored that callback argument and falsely logged a second
		// server as connected when the port was already occupied.
		const conflict = spawn(process.execPath, [
			"dist/index.js",
			"--transport", "http",
			"--auth", "none",
			"--host", "127.0.0.1",
			"--port", String(port),
			"--cwd", cwd,
		], { env: cleanEnv, stdio: ["ignore", "ignore", "pipe"] });
		let conflictError = "";
		conflict.stderr.setEncoding("utf8");
		conflict.stderr.on("data", chunk => { conflictError += chunk; });
		const conflictCode = await new Promise((resolve) => conflict.once("exit", resolve));
		assert(conflictCode !== 0, "second HTTP server unexpectedly bound the occupied port");
		assert(/EADDRINUSE/.test(conflictError), `missing EADDRINUSE diagnostic: ${conflictError}`);

		const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
		await client.connect(transport);

		const listed = await client.listTools();
		const names = listed.tools.map((tool) => tool.name).sort();
		assert(JSON.stringify(names) === JSON.stringify(["bash", "edit", "read", "write"]), `unexpected tools: ${names}`);

		const bash = await client.callTool({ name: "bash", arguments: { command: "printf 'http-ok'" } });
		assert(!bash.isError, `HTTP bash failed: ${resultText(bash)}`);
		assert(resultText(bash).includes("http-ok"), `unexpected HTTP bash output: ${resultText(bash)}`);

		const controller = new AbortController();
		const longCommand = `for i in 1 2 3 4 5; do echo "tick$i" >> "${ticksPath}"; sleep 1; done`;
		const abortTimer = setTimeout(() => controller.abort(), 1500);
		let canceled = false;
		try {
			await client.callTool(
				{ name: "bash", arguments: { command: longCommand } },
				undefined,
				{ signal: controller.signal },
			);
		} catch {
			canceled = true;
		} finally {
			clearTimeout(abortTimer);
		}
		assert(canceled, "expected HTTP tool request cancellation to reject");

		const followup = await client.callTool({ name: "bash", arguments: { command: "printf 'survived-http-cancel'" } });
		assert(!followup.isError, `follow-up HTTP bash failed: ${resultText(followup)}`);
		assert(resultText(followup).includes("survived-http-cancel"), `unexpected follow-up output: ${resultText(followup)}`);

		await new Promise((resolve) => setTimeout(resolve, 5500));
		const contents = await readFile(ticksPath, "utf8").catch(() => "");
		const ticks = contents.split("\n").filter((line) => line.startsWith("tick"));
		assert(ticks.length < 5, `HTTP cancellation failed; command wrote all ${ticks.length} ticks`);

		console.log(`PASS: Streamable HTTP tools work; cancellation wrote ${ticks.length} ticks and server remained usable`);
	} finally {
		await client.close().catch(() => undefined);
		child.kill("SIGTERM");
		await new Promise((resolve) => child.once("exit", resolve)).catch(() => undefined);
		await rm(cwd, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
