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

const json = (content) => JSON.parse(text(content));

async function connect(cwd, fakeHerdr, state, log, extraEnv = {}) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["dist/index.js", "--cwd", cwd],
		env: {
			...process.env,
			PI_MCP_HERDR_SESSION: "pi-as-mcp-test",
			PI_MCP_HERDR_BIN: fakeHerdr,
			PI_MCP_TRANSPORT: "stdio",
			PI_MCP_AUTH: "none",
			FAKE_HERDR_STATE: state,
			FAKE_HERDR_LOG: log,
			HERDR_ENV: "1",
			HERDR_SESSION: "default",
			HERDR_SOCKET_PATH: "/tmp/default-herdr.sock",
			HERDR_PANE_ID: "w-default:p1",
			HERDR_TAB_ID: "w-default:t1",
			HERDR_WORKSPACE_ID: "w-default",
			...extraEnv,
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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
const readState = () => running() ? JSON.parse(readFileSync(state, "utf8")) : {agents:[], nextWorkspace:1};
const saveState = (value) => writeFileSync(state, JSON.stringify(value));
if (args[0] === "agent" && args[1] === "start" && args[2] === "--help") {
  console.log("Start a supported interactive agent in an existing pane\\n\\n      --kind <KIND>\\n          Supported agent kind and canonical executable\\n          [possible values: pi, codex, hermes, cursor]");
  process.exit(0);
}
if (args[0] === "integration" && args[1] === "status") {
  console.log("pi: current (v8) (/fake/pi)\\ncodex: current (v8) (/fake/codex)\\nhermes: outdated (v4) (/fake/hermes)\\ncursor: not installed (/fake/cursor)");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  const sessions = running() ? [{name:"pi-as-mcp-test",default:false,running:true,socket_path:"/fake/pi-as-mcp-test.sock",session_dir:"/fake"}] : [];
  console.log(JSON.stringify({sessions})); process.exit(0);
}
if (args[0] !== "--session" || args[1] !== "pi-as-mcp-test") { console.error("wrong session"); process.exit(2); }
const cmd = args.slice(2);
if (cmd[0] === "server") { saveState({agents:[], nextWorkspace:1}); process.exit(0); }
if (!running()) { console.error(JSON.stringify({error:{code:"server_not_running",message:"server is not running"}})); process.exit(1); }
if (cmd[0] === "api" && cmd[1] === "snapshot") { const s=readState(); console.log(JSON.stringify({id:"fake",result:{snapshot:{agents:s.agents,workspaces:[]}}})); process.exit(0); }
if (cmd[0] === "workspace" && cmd[1] === "create") {
  const s=readState(); const id="w"+s.nextWorkspace++; s.pending={workspace_id:id,pane_id:id+":p1",cwd:cmd[3],label:cmd[5]}; saveState(s);
  console.log(JSON.stringify({result:{workspace:{workspace_id:id},root_pane:{pane_id:id+":p1"}}})); process.exit(0);
}
if (cmd[0] === "workspace" && cmd[1] === "close") {
  const s=readState(); s.agents=s.agents.filter(a=>a.workspace_id!==cmd[2]); saveState(s);
  console.log(JSON.stringify({result:{closed:true}})); process.exit(0);
}
if (cmd[0] === "agent" && cmd[1] === "list") { const s=readState(); console.log(JSON.stringify({result:{agents:s.agents}})); process.exit(0); }
if (cmd[0] === "agent" && cmd[1] === "start") {
  const s=readState(); const pending=s.pending; const kind=cmd[cmd.indexOf("--kind")+1];
  const agent={name:cmd[2],agent:kind,agent_status:"idle",interactive_ready:true,workspace_id:pending.workspace_id,cwd:pending.cwd};
  s.agents.push(agent); delete s.pending; saveState(s); console.log(JSON.stringify({result:{agent}})); process.exit(0);
}
if (cmd[0] === "agent" && cmd[1] === "prompt") {
  const s=readState(); const a=s.agents.find(a=>a.name===cmd[2]); if(!a){console.error(JSON.stringify({error:{code:"agent_name_not_found",message:"missing"}}));process.exit(1);}
  if (cmd[3] === "simulate timeout") { a.agent_status="working"; a.last_output="still working"; saveState(s); console.error(JSON.stringify({error:{code:"timeout",message:"agent wait timed out"}})); process.exit(1); }
  if (cmd[3] === "simulate stalled") { a.agent_status="idle"; a.last_output="prompt accepted but state transition not observed"; saveState(s); console.error(JSON.stringify({error:{code:"agent_prompt_stalled",message:"prompt effect was not observed"}})); process.exit(1); }
  a.agent_status="done"; a.last_output="completed: "+cmd[3]; saveState(s); console.log(JSON.stringify({result:{agent:a}})); process.exit(0);
}
if (cmd[0] === "agent" && cmd[1] === "wait") {
  const s=readState(); const a=s.agents.find(a=>a.name===cmd[2]); if(!a){console.error(JSON.stringify({error:{code:"agent_name_not_found",message:"missing"}}));process.exit(1);}
  console.log(JSON.stringify({result:{agent:a}})); process.exit(0);
}
if (cmd[0] === "agent" && cmd[1] === "get") { const s=readState(); const a=s.agents.find(a=>a.name===cmd[2]); if(!a){console.error(JSON.stringify({error:{code:"agent_name_not_found",message:"missing"}}));process.exit(1);} console.log(JSON.stringify({result:{agent:a}})); process.exit(0); }
if (cmd[0] === "agent" && cmd[1] === "read") { const s=readState(); const a=s.agents.find(a=>a.name===cmd[2]); console.log(a?.last_output || "fake agent output"); process.exit(0); }
if (cmd[0] === "agent" && cmd[1] === "send-keys") {
  const s=readState(); const a=s.agents.find(a=>a.name===cmd[2]);
  if (a && cmd.slice(3).includes("ctrl+c")) { a.agent_status="idle"; a.last_output="interrupted"; saveState(s); }
  console.log(JSON.stringify({result:{sent:true}})); process.exit(0);
}
console.error(JSON.stringify({error:{code:"unsupported",message:"unsupported fake herdr command: "+cmd.join(" ")}})); process.exit(2);
`);
	await chmod(fakeHerdr, 0o755);

	try {
		const client = await connect(cwd, fakeHerdr, state, log);
		clients.push(client);

		const { tools } = await client.listTools();
		const names = tools.map((tool) => tool.name);
		for (const required of ["list_agents", "spawn_agent", "send_input", "wait_agent", "read_agent", "send_agent_keys", "interrupt_agent", "close_agent"]) {
			assert(names.includes(required), `${required} missing from ${names}`);
		}
		assert(!names.includes("agent"), "legacy mega-tool should not be model-facing");
		const spawn = tools.find((tool) => tool.name === "spawn_agent");
		assert(spawn.inputSchema.properties.kind.enum.join(",") === "pi,codex,hermes", `installed kind enum: ${JSON.stringify(spawn.inputSchema)}`);
		assert(spawn.description.includes("Pi coding agent") && spawn.description.includes("Hermes Agent") && !spawn.description.includes("Cursor coding agent"), `installed catalog filtering: ${spawn.description}`);

		let result = await client.callTool({ name: "list_agents", arguments: {} });
		let payload = json(result.content);
		assert(result.isError !== true && payload.kinds.length === 3, `list_agents: ${text(result.content)}`);
		assert(payload.kinds[0].integration === "current" && payload.kinds[2].integration === "outdated", `catalog integration: ${text(result.content)}`);

		result = await client.callTool({ name: "spawn_agent", arguments: { kind: "hermes", name: "runtime", message: "must fail", cwd: "." } });
		assert(result.isError === true && text(result.content).includes("reserved"), `reserved agent name: ${text(result.content)}`);

		result = await client.callTool({ name: "spawn_agent", arguments: { kind: "hermes", message: "Audit the diff", cwd: "." } });
		payload = json(result.content);
		assert(result.isError !== true && payload.name === "hermes" && payload.submitted === true, `spawn: ${text(result.content)}`);
		assert(payload.output.includes("completed: Audit the diff"), `spawn output: ${text(result.content)}`);

		result = await client.callTool({ name: "spawn_agent", arguments: { kind: "hermes", message: "Second hermes", cwd: "." } });
		payload = json(result.content);
		assert(result.isError !== true && payload.name === "hermes-2", `generated collision name: ${text(result.content)}`);
		result = await client.callTool({ name: "close_agent", arguments: { target: "hermes-2" } });
		assert(result.isError !== true, `close generated collision agent: ${text(result.content)}`);

		result = await client.callTool({ name: "send_input", arguments: { target: "hermes", message: "Check tests" } });
		payload = json(result.content);
		assert(payload.output.includes("completed: Check tests"), `send_input output: ${text(result.content)}`);

		result = await client.callTool({ name: "send_input", arguments: { target: "hermes", message: "simulate stalled" } });
		payload = json(result.content);
		assert(result.isError !== true && payload.prompt_stalled === true && payload.agent.status === "idle", `prompt stalled handling: ${text(result.content)}`);

		result = await client.callTool({ name: "spawn_agent", arguments: { kind: "pi", message: "Independent review", cwd: "." } });
		assert(result.isError !== true, `second spawn: ${text(result.content)}`);

		result = await client.callTool({ name: "send_input", arguments: { target: "pi", message: "simulate timeout", timeout: 1 } });
		payload = json(result.content);
		assert(result.isError !== true && payload.timed_out === true && payload.agent.status === "working", `structured timeout: ${text(result.content)}`);

		result = await client.callTool({ name: "close_agent", arguments: { target: "pi" } });
		assert(result.isError === true && text(result.content).includes("still working"), `working close guard: ${text(result.content)}`);

		result = await client.callTool({ name: "interrupt_agent", arguments: { target: "pi" } });
		payload = json(result.content);
		assert(result.isError !== true && payload.state.agent.status === "idle", `interrupt_agent: ${text(result.content)}`);

		result = await client.callTool({ name: "wait_agent", arguments: { targets: ["hermes", "pi"], mode: "all", timeout: 1 } });
		payload = json(result.content);
		assert(payload.mode === "all" && payload.results.length === 2, `wait all: ${text(result.content)}`);

		result = await client.callTool({ name: "wait_agent", arguments: { targets: ["hermes", "pi"], mode: "any", timeout: 1 } });
		payload = json(result.content);
		assert(payload.mode === "any" && ["hermes", "pi"].includes(payload.winner.target), `wait any: ${text(result.content)}`);
		assert(payload.winner.result.output, `wait should include output: ${text(result.content)}`);

		result = await client.callTool({ name: "send_input", arguments: { target: "pi", message: "simulate timeout", timeout: 1 } });
		payload = json(result.content);
		assert(payload.agent.status === "working", `force-close setup: ${text(result.content)}`);
		result = await client.callTool({ name: "close_agent", arguments: { target: "pi", force: true } });
		assert(result.isError !== true, `force close working agent: ${text(result.content)}`);

		result = await client.callTool({ name: "read_agent", arguments: { target: "hermes", lines: 20 } });
		assert(text(result.content)?.includes("prompt accepted"), `read_agent: ${text(result.content)}`);

		result = await client.callTool({ name: "send_agent_keys", arguments: { target: "hermes", keys: ["esc"] } });
		assert(result.isError !== true && text(result.content)?.includes("sent"), `send_agent_keys: ${text(result.content)}`);

		result = await client.callTool({ name: "close_agent", arguments: { target: "hermes" } });
		payload = json(result.content);
		assert(result.isError !== true && payload.output.includes("prompt accepted"), `close capture: ${text(result.content)}`);

		await client.close();
		clients.pop();

		const client2 = await connect(cwd, fakeHerdr, state, log);
		clients.push(client2);
		await client2.listTools();
		await client2.close();
		clients.pop();

		const limited = await connect(cwd, fakeHerdr, state, log, { PI_MCP_MAX_AGENTS: "1" });
		clients.push(limited);
		result = await limited.callTool({ name: "spawn_agent", arguments: { kind: "pi", message: "one slot" } });
		assert(result.isError !== true, `max-agent first spawn: ${text(result.content)}`);
		result = await limited.callTool({ name: "spawn_agent", arguments: { kind: "hermes", message: "should exceed limit" } });
		assert(result.isError === true && text(result.content).includes("agent limit reached"), `max-agent guard: ${text(result.content)}`);
		result = await limited.callTool({ name: "close_agent", arguments: { target: "pi" } });
		assert(result.isError !== true, `max-agent cleanup: ${text(result.content)}`);

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
