import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BUN, childEnv, firstText, jsonContent } from "./helpers";

const assert = (condition: unknown, message: string) => {
	expect(Boolean(condition), message).toBe(true);
};

async function connect(
	cwd: string,
	fakeHerdr: string,
	state: string,
	log: string,
	extraEnv: Record<string, string | undefined> = {},
): Promise<Client> {
	const transport = new StdioClientTransport({
		command: BUN,
		args: ["src/index.ts", "--cwd", cwd],
		env: childEnv({
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
		}),
		stderr: "inherit",
	});
	const client = new Client({ name: "test-herdr", version: "0.0.0" });
	await client.connect(transport);
	return client;
}

const runHerdrTest = process.platform === "win32" ? test.skip : test;

runHerdrTest("persistent Herdr agent lifecycle and isolation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mcp-herdr-"));
	const cwd = join(dir, "work");
	const fakeHerdr = join(dir, "fake-herdr.ts");
	const state = join(dir, "running.json");
	const log = join(dir, "calls.ndjson");
	const clients: Client[] = [];

	await mkdir(cwd);
	await Bun.write(fakeHerdr, `#!/usr/bin/env bun
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
  console.log("Start a supported interactive agent in an existing pane\\n\\n      --kind <KIND>\\n          Supported agent kind and canonical executable\\n          [possible values: pi, codex, omp, hermes, cursor]");
  process.exit(0);
}
if (args[0] === "integration" && args[1] === "status") {
  console.log("pi: current (v8) (/fake/pi)\\ncodex: current (v8) (/fake/codex)\\nomp: current (v8) (/fake/omp)\\nhermes: outdated (v4) (/fake/hermes)\\ncursor: not installed (/fake/cursor)");
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
		expect(names).not.toContain("agent");

		const spawn = tools.find((tool) => tool.name === "spawn_agent") as any;
		expect(spawn.inputSchema.properties.kind.enum).toEqual(["pi", "codex", "omp", "hermes"]);
		expect(spawn.description).toContain("Default agent: omp");
		expect(spawn.description).toContain("Pi coding agent");
		expect(spawn.description).toContain("Hermes Agent");
		expect(spawn.description).not.toContain("Cursor coding agent");
		expect(spawn.inputSchema.required).toEqual(["message"]);

		let result = await client.callTool({ name: "list_agents", arguments: {} });
		let payload = jsonContent(result.content);
		expect(result.isError).not.toBe(true);
		expect(payload.default_agent).toBe("omp");
		expect(payload.kinds).toHaveLength(4);
		expect(payload.kinds[0].integration).toBe("current");
		expect(payload.kinds[3].integration).toBe("outdated");

		result = await client.callTool({ name: "spawn_agent", arguments: { message: "Default backend", cwd: "." } });
		payload = jsonContent(result.content);
		expect(result.isError).not.toBe(true);
		expect(payload.kind).toBe("omp");
		expect(payload.name).toBe("omp");
		result = await client.callTool({ name: "close_agent", arguments: { target: "omp" } });
		expect(result.isError).not.toBe(true);

		result = await client.callTool({ name: "spawn_agent", arguments: { kind: "hermes", message: "Audit the diff", cwd: "." } });
		payload = jsonContent(result.content);
		expect(result.isError).not.toBe(true);
		expect(payload.name).toBe("hermes");
		expect(payload.submitted).toBe(true);
		expect(payload.output).toContain("completed: Audit the diff");

		result = await client.callTool({ name: "spawn_agent", arguments: { kind: "hermes", message: "Second hermes", cwd: "." } });
		payload = jsonContent(result.content);
		expect(payload.name).toBe("hermes-2");
		result = await client.callTool({ name: "close_agent", arguments: { target: "hermes-2" } });
		expect(result.isError).not.toBe(true);

		result = await client.callTool({ name: "send_input", arguments: { target: "hermes", message: "Check tests" } });
		expect(jsonContent(result.content).output).toContain("completed: Check tests");

		result = await client.callTool({ name: "send_input", arguments: { target: "hermes", message: "simulate stalled" } });
		payload = jsonContent(result.content);
		expect(result.isError).not.toBe(true);
		expect(payload.prompt_stalled).toBe(true);
		expect(payload.agent.status).toBe("idle");

		result = await client.callTool({ name: "spawn_agent", arguments: { kind: "pi", message: "Independent review", cwd: "." } });
		expect(result.isError).not.toBe(true);

		result = await client.callTool({ name: "send_input", arguments: { target: "pi", message: "simulate timeout", timeout: 1 } });
		payload = jsonContent(result.content);
		expect(result.isError).not.toBe(true);
		expect(payload.timed_out).toBe(true);
		expect(payload.agent.status).toBe("working");

		result = await client.callTool({ name: "close_agent", arguments: { target: "pi" } });
		expect(result.isError).toBe(true);
		expect(firstText(result.content)).toContain("still working");

		result = await client.callTool({ name: "interrupt_agent", arguments: { target: "pi" } });
		expect(jsonContent(result.content).state.agent.status).toBe("idle");

		result = await client.callTool({ name: "wait_agent", arguments: { targets: ["hermes", "pi"], mode: "all", timeout: 1 } });
		payload = jsonContent(result.content);
		expect(payload.mode).toBe("all");
		expect(payload.results).toHaveLength(2);

		result = await client.callTool({ name: "wait_agent", arguments: { targets: ["hermes", "pi"], mode: "any", timeout: 1 } });
		payload = jsonContent(result.content);
		expect(payload.mode).toBe("any");
		expect(["hermes", "pi"]).toContain(payload.winner.target);
		expect(payload.winner.result.output).toBeTruthy();

		result = await client.callTool({ name: "send_input", arguments: { target: "pi", message: "simulate timeout", timeout: 1 } });
		expect(jsonContent(result.content).agent.status).toBe("working");
		result = await client.callTool({ name: "close_agent", arguments: { target: "pi", force: true } });
		expect(result.isError).not.toBe(true);

		result = await client.callTool({ name: "read_agent", arguments: { target: "hermes", lines: 20 } });
		expect(firstText(result.content)).toContain("prompt accepted");

		result = await client.callTool({ name: "send_agent_keys", arguments: { target: "hermes", keys: ["esc"] } });
		expect(result.isError).not.toBe(true);
		expect(firstText(result.content)).toContain("sent");

		result = await client.callTool({ name: "close_agent", arguments: { target: "hermes" } });
		expect(jsonContent(result.content).output).toContain("prompt accepted");

		await client.close();
		clients.pop();

		const client2 = await connect(cwd, fakeHerdr, state, log);
		clients.push(client2);
		await client2.listTools();
		await client2.close();
		clients.pop();

		const explicitDefault = await connect(cwd, fakeHerdr, state, log, { PI_MCP_DEFAULT_AGENT: "pi" });
		clients.push(explicitDefault);
		result = await explicitDefault.callTool({ name: "list_agents", arguments: {} });
		expect(jsonContent(result.content).default_agent).toBe("pi");
		result = await explicitDefault.callTool({ name: "spawn_agent", arguments: { message: "explicit default" } });
		expect(jsonContent(result.content).kind).toBe("pi");
		result = await explicitDefault.callTool({ name: "close_agent", arguments: { target: "pi" } });
		expect(result.isError).not.toBe(true);
		await explicitDefault.close();
		clients.pop();

		const invalidDefault = await connect(cwd, fakeHerdr, state, log, { PI_MCP_DEFAULT_AGENT: "cursor" });
		clients.push(invalidDefault);
		const invalidDefaultTools = await invalidDefault.listTools();
		expect(invalidDefaultTools.tools.some((tool) => tool.name === "read")).toBe(true);
		expect(invalidDefaultTools.tools.some((tool) => tool.name === "spawn_agent")).toBe(false);
		await invalidDefault.close();
		clients.pop();

		const limited = await connect(cwd, fakeHerdr, state, log, { PI_MCP_MAX_AGENTS: "1" });
		clients.push(limited);
		result = await limited.callTool({ name: "spawn_agent", arguments: { kind: "pi", message: "one slot" } });
		expect(result.isError).not.toBe(true);
		result = await limited.callTool({ name: "spawn_agent", arguments: { kind: "hermes", message: "should exceed limit" } });
		expect(result.isError).toBe(true);
		expect(firstText(result.content)).toContain("agent limit reached");
		result = await limited.callTool({ name: "close_agent", arguments: { target: "pi" } });
		expect(result.isError).not.toBe(true);

		const calls = (await Bun.file(log).text()).trim().split("\n").map((line) => JSON.parse(line));
		const serverStarts = calls.filter((call) => call.args.at(-1) === "server");
		expect(serverStarts).toHaveLength(1);
		for (const call of calls) {
			for (const [key, value] of Object.entries(call.env)) {
				expect(value, `inherited ${key} leaked to Herdr child`).toBeUndefined();
			}
		}
	} finally {
		for (const client of clients.reverse()) await client.close().catch(() => undefined);
		await rm(dir, { recursive: true, force: true });
	}
}, 20_000);
