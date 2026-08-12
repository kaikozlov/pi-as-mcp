// Protocol-level smoke test for the optional Herdr agent integration.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.platform === "win32") {
	console.log("Herdr smoke skipped on Windows (fake executable uses a POSIX shebang)");
	process.exit(0);
}

const assert = (cond, msg) => {
	if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
};

const text = (content) => {
	const block = content?.[0];
	return block?.type === "text" ? block.text : undefined;
};

async function connect(cwd, fakeHerdr, state, log) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["dist/index.js", "--cwd", cwd],
		env: {
			...process.env,
			PI_MCP_HERDR_SESSION: "pi-as-mcp-test",
			PI_MCP_HERDR_BIN: fakeHerdr,
			FAKE_HERDR_STATE: state,
			FAKE_HERDR_LOG: log,
			// Pretend the MCP server itself was launched from an unrelated Herdr
			// session. The adapter must never leak these values to its own session.
			HERDR_ENV: "1",
			HERDR_SESSION: "default",
			HERDR_SOCKET_PATH: "/tmp/default-herdr.sock",
			HERDR_PANE_ID: "w-default:p1",
			HERDR_TAB_ID: "w-default:t1",
			HERDR_WORKSPACE_ID: "w-default",
		},
		stderr: "inherit",
	});
	const client = new Client({ name: "smoke-herdr", version: "0.0.0" });
	await client.connect(transport);
	return client;
}

async function main() {
	const dir = await mkdtemp(join(tmpdir(), "pi-mcp-herdr-"));
	const cwd = join(dir, "work");
	const fakeHerdr = join(dir, "fake-herdr.mjs");
	const state = join(dir, "running.json");
	const log = join(dir, "calls.ndjson");
	const clients = [];

	await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
	await writeFile(fakeHerdr, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const state = process.env.FAKE_HERDR_STATE;
const log = process.env.FAKE_HERDR_LOG;
appendFileSync(log, JSON.stringify({ args, env: {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_SESSION: process.env.HERDR_SESSION,
  HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  HERDR_TAB_ID: process.env.HERDR_TAB_ID,
  HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
} }) + "\\n");
const running = () => existsSync(state);
if (args[0] === "session" && args[1] === "list") {
  const sessions = running() ? [{name:"pi-as-mcp-test",default:false,running:true,socket_path:"/fake/pi-as-mcp-test.sock",session_dir:"/fake"}] : [];
  console.log(JSON.stringify({sessions})); process.exit(0);
}
if (args[0] !== "--session" || args[1] !== "pi-as-mcp-test") { console.error("wrong session"); process.exit(2); }
const cmd = args.slice(2);
if (cmd[0] === "server") { writeFileSync(state, "{}\\n"); process.exit(0); }
if (!running()) { console.error(JSON.stringify({error:{code:"server_not_running"}})); process.exit(1); }
if (cmd[0] === "api" && cmd[1] === "snapshot") { console.log(JSON.stringify({id:"fake",result:{snapshot:{agents:[],workspaces:[]}}})); process.exit(0); }
if (cmd[0] === "workspace" && cmd[1] === "create") { console.log(JSON.stringify({result:{workspace:{workspace_id:"w1"},root_pane:{pane_id:"w1:p1"}}})); process.exit(0); }
if (cmd[0] === "workspace" && cmd[1] === "close") { console.log(JSON.stringify({result:{closed:true}})); process.exit(0); }
if (cmd[0] === "agent" && cmd[1] === "list") { console.log(JSON.stringify({result:{agents:[]}})); process.exit(0); }
if (cmd[0] === "agent" && cmd[1] === "start") { console.log(JSON.stringify({result:{agent:{agent:cmd[2],agent_status:"idle",pane_id:"w1:p1"}}})); process.exit(0); }
if (cmd[0] === "agent" && cmd[1] === "prompt") { console.log(JSON.stringify({result:{agent:{agent:cmd[2],agent_status:"done"}}})); process.exit(0); }
if (cmd[0] === "agent" && cmd[1] === "wait") { console.log(JSON.stringify({result:{agent:{agent:cmd[2],agent_status:"done"}}})); process.exit(0); }
if (cmd[0] === "agent" && cmd[1] === "get") { console.log(JSON.stringify({result:{agent:{agent:cmd[2],agent_status:"working",workspace_id:"w1"}}})); process.exit(0); }
if (cmd[0] === "agent" && cmd[1] === "read") { console.log("fake agent output"); process.exit(0); }
if (cmd[0] === "agent" && cmd[1] === "send-keys") { console.log(JSON.stringify({result:{sent:true}})); process.exit(0); }
console.error("unsupported fake herdr command: " + cmd.join(" ")); process.exit(2);
`);
	await chmod(fakeHerdr, 0o755);

	try {
		const client = await connect(cwd, fakeHerdr, state, log);
		clients.push(client);

		const { tools } = await client.listTools();
		assert(tools.map((tool) => tool.name).includes("agent"), `agent missing from ${tools.map((tool) => tool.name)}`);

		let result = await client.callTool({ name: "agent", arguments: { action: "list" } });
		assert(result.isError !== true && text(result.content)?.includes("agents"), `list: ${text(result.content)}`);

		result = await client.callTool({
			name: "agent",
			arguments: { action: "start", name: "runtime", kind: "codex", cwd: "." },
		});
		assert(result.isError === true && text(result.content)?.includes("reserved"), `reserved runtime name: ${text(result.content)}`);

		result = await client.callTool({
			name: "agent",
			arguments: { action: "start", name: "reviewer", kind: "codex", cwd: "." },
		});
		assert(result.isError !== true && text(result.content)?.includes("reviewer"), `start: ${text(result.content)}`);

		result = await client.callTool({
			name: "agent",
			arguments: { action: "prompt", target: "reviewer", prompt: "Review the diff" },
		});
		assert(result.isError !== true && text(result.content)?.includes("done"), `prompt: ${text(result.content)}`);

		result = await client.callTool({ name: "agent", arguments: { action: "wait", target: "reviewer", timeout: 1 } });
		assert(result.isError !== true && text(result.content)?.includes("done"), `wait: ${text(result.content)}`);

		result = await client.callTool({ name: "agent", arguments: { action: "read", target: "reviewer", lines: 20 } });
		assert(text(result.content)?.includes("fake agent output"), `read: ${text(result.content)}`);

		result = await client.callTool({ name: "agent", arguments: { action: "send_keys", target: "reviewer", keys: ["esc"] } });
		assert(result.isError !== true && text(result.content)?.includes("sent"), `send_keys: ${text(result.content)}`);

		result = await client.callTool({ name: "agent", arguments: { action: "close", target: "reviewer" } });
		assert(result.isError !== true && text(result.content)?.includes("closed"), `close: ${text(result.content)}`);

		await client.close();
		clients.pop();

		// A second MCP server must reuse the already-running named session instead
		// of spawning another server.
		const client2 = await connect(cwd, fakeHerdr, state, log);
		clients.push(client2);
		await client2.listTools();

		const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const serverStarts = calls.filter((call) => call.args.at(-1) === "server");
		assert(serverStarts.length === 1, `expected one server start, got ${serverStarts.length}`);
		for (const call of calls) {
			for (const [key, value] of Object.entries(call.env)) {
				assert(value === undefined, `inherited ${key} leaked to Herdr child: ${value}`);
			}
		}

		console.log("Herdr integration smoke passed");
	} finally {
		for (const client of clients.reverse()) await client.close().catch(() => undefined);
		await rm(dir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
