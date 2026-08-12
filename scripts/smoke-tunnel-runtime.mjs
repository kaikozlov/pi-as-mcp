import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const assert = (condition, message) => {
	if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
};

if (process.platform === "win32") {
	console.log("Tunnel runtime smoke skipped on Windows");
	process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), "pi-mcp-tunnel-runtime-"));
const fakeHerdr = join(dir, "fake-herdr.mjs");
const statePath = join(dir, "state.json");
const logPath = join(dir, "calls.ndjson");

await writeFile(statePath, JSON.stringify({ server: false, workspace: false, tunnel: false, startChecks: 0 }));
await writeFile(fakeHerdr, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const statePath = process.env.FAKE_HERDR_STATE;
const logPath = process.env.FAKE_HERDR_LOG;
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const writeState = (value) => writeFileSync(statePath, JSON.stringify(value));
appendFileSync(logPath, JSON.stringify({args, env:{
  HERDR_ENV:process.env.HERDR_ENV,
  HERDR_SESSION:process.env.HERDR_SESSION,
  HERDR_SOCKET_PATH:process.env.HERDR_SOCKET_PATH,
  HERDR_PANE_ID:process.env.HERDR_PANE_ID,
  HERDR_TAB_ID:process.env.HERDR_TAB_ID,
  HERDR_WORKSPACE_ID:process.env.HERDR_WORKSPACE_ID,
}}) + "\\n");
let state = readState();
if (args[0] === "session" && args[1] === "list") {
  console.log(JSON.stringify({sessions: state.server ? [{name:"pi-as-mcp-test",running:true}] : []}));
  process.exit(0);
}
if (args[0] !== "--session" || args[1] !== "pi-as-mcp-test") { console.error("wrong session"); process.exit(2); }
const cmd = args.slice(2);
if (cmd[0] === "server") { state.server = true; writeState(state); process.exit(0); }
if (!state.server) { console.error(JSON.stringify({error:{code:"server_not_running"}})); process.exit(1); }
if (cmd[0] === "api" && cmd[1] === "snapshot") { console.log(JSON.stringify({result:{snapshot:{}}})); process.exit(0); }
if (cmd[0] === "workspace" && cmd[1] === "list") {
  console.log(JSON.stringify({result:{workspaces: state.workspace ? [{workspace_id:"w-runtime",label:"runtime"}] : []}})); process.exit(0);
}
if (cmd[0] === "workspace" && cmd[1] === "create") {
  state.workspace = true; writeState(state);
  console.log(JSON.stringify({result:{workspace:{workspace_id:"w-runtime",label:"runtime"},root_pane:{pane_id:"w-runtime:p1",terminal_id:"term-runtime",workspace_id:"w-runtime"}}})); process.exit(0);
}
if (cmd[0] === "pane" && cmd[1] === "list") {
  console.log(JSON.stringify({result:{panes: state.workspace ? [{workspace_id:"w-runtime",pane_id:"w-runtime:p1",terminal_id:"term-runtime"}] : []}})); process.exit(0);
}
if (cmd[0] === "pane" && cmd[1] === "process-info") {
  if (state.startChecks > 0) {
    state.startChecks -= 1;
    if (state.startChecks === 0) state.tunnel = true;
    writeState(state);
  }
  const foreground = state.tunnel
    ? [{pid:200,name:"tunnel-client",cmdline:"./bin/tunnel-client run --profile-file ./tunnel/profile.yaml",argv:["./bin/tunnel-client","run"]}]
    : [{pid:100,name:"zsh",cmdline:"-zsh",argv:["-zsh"]}];
  console.log(JSON.stringify({result:{process_info:{pane_id:"w-runtime:p1",shell_pid:100,foreground_processes:foreground}}})); process.exit(0);
}
if (cmd[0] === "pane" && cmd[1] === "run") { state.startChecks = 2; writeState(state); process.exit(0); }
if (cmd[0] === "pane" && cmd[1] === "send-keys") { state.tunnel = false; writeState(state); console.log(JSON.stringify({result:{sent:true}})); process.exit(0); }
if (cmd[0] === "pane" && cmd[1] === "read") { console.log("fake runtime output"); process.exit(0); }
if (cmd[0] === "terminal" && cmd[1] === "attach") { console.log("FAKE_ATTACH_OK"); process.exit(0); }
console.error("unsupported: " + cmd.join(" ")); process.exit(2);
`);
await chmod(fakeHerdr, 0o755);

const baseEnv = {
	...process.env,
	PI_MCP_HERDR_SESSION: "pi-as-mcp-test",
	PI_MCP_HERDR_BIN: fakeHerdr,
	PI_MCP_TUNNEL_HEALTH_PORT: "65534",
	FAKE_HERDR_STATE: statePath,
	FAKE_HERDR_LOG: logPath,
	HERDR_ENV: "1",
	HERDR_SESSION: "default",
	HERDR_SOCKET_PATH: "/tmp/default.sock",
	HERDR_PANE_ID: "default:p1",
	HERDR_TAB_ID: "default:t1",
	HERDR_WORKSPACE_ID: "default",
};

function runtime(...args) {
	return spawnSync(process.execPath, ["scripts/tunnel-runtime.mjs", ...args], {
		cwd: new URL("..", import.meta.url).pathname,
		env: baseEnv,
		encoding: "utf8",
	});
}

try {
	let result = runtime("start");
	assert(result.status === 0, `first start failed: ${result.stderr}`);
	assert(result.stdout.includes("Runtime:         running"), `missing running status: ${result.stdout}`);

	result = runtime("start");
	assert(result.status === 0, `second start failed: ${result.stderr}`);

	result = runtime("attach");
	assert(result.status === 0 && result.stdout.includes("FAKE_ATTACH_OK"), `attach failed: ${result.stdout} ${result.stderr}`);

	result = runtime("stop");
	assert(result.status === 0 && result.stdout.includes("persistent runtime shell remains"), `stop failed: ${result.stdout} ${result.stderr}`);

	result = runtime("info");
	assert(result.status === 0 && result.stdout.includes("Runtime:         stopped"), `info after stop failed: ${result.stdout}`);

	const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert(calls.filter((call) => call.args.at(-1) === "server").length === 1, "server should start exactly once");
	assert(calls.filter((call) => call.args.includes("create") && call.args.includes("workspace")).length === 1, "runtime workspace should be created exactly once");
	assert(calls.filter((call) => call.args.includes("run") && call.args.includes("pane")).length === 1, "tunnel command should be launched exactly once");
	for (const call of calls) {
		for (const [key, value] of Object.entries(call.env)) {
			assert(value === undefined, `inherited ${key} leaked to Herdr child: ${value}`);
		}
	}

	console.log("Tunnel runtime smoke passed");
} finally {
	await rm(dir, { recursive: true, force: true });
}
