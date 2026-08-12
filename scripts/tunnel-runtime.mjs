#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION = process.env.PI_MCP_HERDR_SESSION?.trim();
const HERDR = process.env.PI_MCP_HERDR_BIN?.trim() || "herdr";
const RUNTIME_LABEL = "runtime";
const HEALTH_PORT = Number.parseInt(process.env.PI_MCP_TUNNEL_HEALTH_PORT ?? "8080", 10);
const STARTUP_TIMEOUT_MS = 15_000;
const LAUNCH_GRACE_MS = 1_000;
const LOCK_TIMEOUT_MS = 5_000;
const POLL_MS = 100;
const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

if (!SESSION) fail("PI_MCP_HERDR_SESSION is required for persistent tunnel lifecycle management");
if (SESSION === "default") fail("PI_MCP_HERDR_SESSION=default is not allowed; use a dedicated named Herdr session");
if (SESSION === "." || SESSION === ".." || !SESSION_NAME_RE.test(SESSION)) {
	fail("PI_MCP_HERDR_SESSION must be 1-64 ASCII letters, numbers, '.', '_' or '-', and cannot be '.' or '..'");
}
if (!Number.isInteger(HEALTH_PORT) || HEALTH_PORT < 1 || HEALTH_PORT > 65535) fail("PI_MCP_TUNNEL_HEALTH_PORT must be a valid TCP port");

function fail(message) {
	console.error(message);
	process.exit(1);
}

function cleanEnv() {
	const env = { ...process.env };
	for (const key of [
		"HERDR_ENV",
		"HERDR_SESSION",
		"HERDR_SOCKET_PATH",
		"HERDR_CLIENT_SOCKET_PATH",
		"HERDR_PANE_ID",
		"HERDR_TAB_ID",
		"HERDR_WORKSPACE_ID",
		"HERDR_ACTIVE_PANE_ID",
		"HERDR_ACTIVE_TAB_ID",
		"HERDR_ACTIVE_WORKSPACE_ID",
	]) delete env[key];
	return env;
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function acquireLifecycleLock() {
	const lockDir = join(tmpdir(), `pi-as-mcp-herdr-${SESSION}.lock`);
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			mkdirSync(lockDir, { mode: 0o700 });
			writeFileSync(join(lockDir, "pid"), `${process.pid}\n`, { mode: 0o600 });
			return () => rmSync(lockDir, { recursive: true, force: true });
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			let owner;
			try {
				owner = Number.parseInt(readFileSync(join(lockDir, "pid"), "utf8").trim(), 10);
			} catch {}
			if (!processAlive(owner)) {
				rmSync(lockDir, { recursive: true, force: true });
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for another pi-as-mcp lifecycle operation (pid ${owner})`);
			sleep(POLL_MS);
		}
	}
}

function withLifecycleLock(fn) {
	const release = acquireLifecycleLock();
	try {
		return fn();
	} finally {
		release();
	}
}

function herdr(args, options = {}) {
	try {
		return execFileSync(HERDR, args, {
			cwd: ROOT,
			env: cleanEnv(),
			encoding: "utf8",
			stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		const stderr = error?.stderr?.toString()?.trim();
		const stdout = error?.stdout?.toString()?.trim();
		throw new Error(stderr || stdout || error?.message || String(error));
	}
}

function herdrJson(args) {
	const raw = herdr(args);
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Herdr returned invalid JSON for ${args.join(" ")}: ${error.message}`);
	}
}

function scoped(args, options) {
	return herdr(["--session", SESSION, ...args], options);
}

function scopedJson(args) {
	return herdrJson(["--session", SESSION, ...args]);
}

function sessionRunning() {
	const response = herdrJson(["session", "list", "--json"]);
	return response.sessions?.some((session) => session.name === SESSION && session.running) ?? false;
}

function ensureServer() {
	if (sessionRunning()) {
		scoped(["api", "snapshot"]);
		return;
	}

	const child = spawn(HERDR, ["--session", SESSION, "server"], {
		cwd: ROOT,
		env: cleanEnv(),
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			if (sessionRunning()) {
				scoped(["api", "snapshot"]);
				return;
			}
		} catch {}
		sleep(POLL_MS);
	}
	throw new Error(`Herdr session ${SESSION} did not become ready within ${STARTUP_TIMEOUT_MS}ms`);
}

function workspaceList() {
	return scopedJson(["workspace", "list"]).result?.workspaces ?? [];
}

function paneList() {
	return scopedJson(["pane", "list"]).result?.panes ?? [];
}

function ensureRuntimeWorkspace() {
	ensureServer();
	const matches = workspaceList().filter((workspace) => workspace.label === RUNTIME_LABEL);
	if (matches.length > 1) throw new Error(`Herdr session ${SESSION} has multiple '${RUNTIME_LABEL}' workspaces; refusing ambiguous lifecycle management`);

	if (matches.length === 0) {
		const created = scopedJson(["workspace", "create", "--cwd", ROOT, "--label", RUNTIME_LABEL, "--no-focus"]).result;
		const workspace = created?.workspace;
		const pane = created?.root_pane;
		if (!workspace?.workspace_id || !pane?.pane_id || !pane?.terminal_id) {
			throw new Error("Herdr did not return runtime workspace, pane, and terminal IDs");
		}
		return { workspaceId: workspace.workspace_id, paneId: pane.pane_id, terminalId: pane.terminal_id };
	}

	const workspaceId = matches[0].workspace_id;
	const panes = paneList().filter((pane) => pane.workspace_id === workspaceId);
	if (panes.length !== 1) {
		throw new Error(`Herdr runtime workspace ${workspaceId} must contain exactly one pane; found ${panes.length}`);
	}
	const pane = panes[0];
	if (!pane.pane_id || !pane.terminal_id) throw new Error(`Herdr runtime workspace ${workspaceId} has an invalid root pane`);
	return { workspaceId, paneId: pane.pane_id, terminalId: pane.terminal_id };
}

function processInfo(paneId) {
	return scopedJson(["pane", "process-info", "--pane", paneId]).result?.process_info;
}

function processText(info) {
	return (info?.foreground_processes ?? [])
		.map((process) => `${process.name ?? ""} ${process.cmdline ?? ""} ${(process.argv ?? []).join(" ")}`)
		.join("\n");
}

function tunnelActive(info) {
	const text = processText(info);
	return text.includes("tunnel-client") && /\brun\b/.test(text);
}

function ownsRuntimeCommand(info) {
	const text = processText(info);
	return text.includes("scripts/tunnel.sh foreground") || text.includes("tunnel-client");
}

function shellIdle(info) {
	if (!info?.shell_pid) return false;
	const foreground = info.foreground_processes ?? [];
	return foreground.length > 0 && foreground.every((process) => process.pid === info.shell_pid);
}

function tunnelHealthy() {
	const result = spawnSync(resolve(ROOT, "bin/tunnel-client"), ["health", "--port", String(HEALTH_PORT), "--require-control-plane-poll"], {
		cwd: ROOT,
		env: process.env,
		stdio: "ignore",
	});
	return result.status === 0;
}

function readRuntime(paneId) {
	try {
		return scoped(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "80"]).trim();
	} catch {
		return "";
	}
}

function ensureTunnel() {
	const runtime = ensureRuntimeWorkspace();
	let info = processInfo(runtime.paneId);
	if (tunnelActive(info)) return runtime;
	if (!shellIdle(info) && !ownsRuntimeCommand(info)) {
		throw new Error(`Herdr runtime pane ${runtime.paneId} is busy with a non-tunnel foreground process:\n${processText(info)}`);
	}

	let submitted = false;
	let sawOwnedProcess = ownsRuntimeCommand(info);
	if (shellIdle(info)) {
		if (tunnelHealthy()) {
			throw new Error(
				"A healthy tunnel is already running outside the dedicated Herdr runtime pane. Stop the legacy foreground tunnel first, then rerun `bun run tunnel` to migrate it.",
			);
		}
		scoped(["pane", "run", runtime.paneId, "./scripts/tunnel.sh foreground"]);
		submitted = true;
	}

	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	const launchGraceDeadline = Date.now() + LAUNCH_GRACE_MS;
	while (Date.now() < deadline) {
		sleep(POLL_MS);
		info = processInfo(runtime.paneId);
		if (tunnelActive(info)) return runtime;
		if (ownsRuntimeCommand(info)) {
			sawOwnedProcess = true;
			continue;
		}
		if (shellIdle(info)) {
			if (submitted && !sawOwnedProcess && Date.now() < launchGraceDeadline) continue;
			const output = readRuntime(runtime.paneId);
			throw new Error(`Tunnel command exited before becoming persistent.${output ? `\n\n${output}` : ""}`);
		}
		throw new Error(`Runtime pane was taken over by a non-tunnel process while starting:\n${processText(info)}`);
	}
	throw new Error(`Tunnel did not become active in Herdr runtime pane ${runtime.paneId} within ${STARTUP_TIMEOUT_MS}ms`);
}

function attach(runtime, takeover) {
	const args = ["--session", SESSION, "terminal", "attach", runtime.terminalId];
	if (takeover) args.push("--takeover");
	const result = spawnSync(HERDR, args, { cwd: ROOT, env: cleanEnv(), stdio: "inherit" });
	if (result.error) throw result.error;
	return result.status ?? 0;
}

function sessionClientEnv() {
	const env = cleanEnv();
	// Preserve only Herdr's nested-client sentinel. Session/socket/pane routing
	// remains stripped so --session is the sole target selector, but a caller
	// already inside another Herdr UI is not allowed to silently nest clients.
	if (process.env.HERDR_ENV) env.HERDR_ENV = process.env.HERDR_ENV;
	return env;
}

function attachSession() {
	const result = spawnSync(HERDR, ["--session", SESSION], { cwd: ROOT, env: sessionClientEnv(), stdio: "inherit" });
	if (result.error) throw result.error;
	return result.status ?? 0;
}

function assertCanAttachSession() {
	if (process.env.HERDR_ENV === "1") {
		throw new Error(
			`Cannot switch from the current Herdr UI into session '${SESSION}' from inside a Herdr-managed pane. ` +
			"Detach the current Herdr client with Ctrl-B q and rerun `bun run tunnel` from the host/SSH shell. " +
			"Use `bun run tunnel:start` if you only want to ensure the dedicated runtime is running without attaching.",
		);
	}
}

function stopTunnel() {
	const runtime = ensureRuntimeWorkspace();
	let info = processInfo(runtime.paneId);
	if (shellIdle(info)) {
		console.log(`Tunnel is already stopped; runtime shell is ${runtime.paneId}.`);
		return;
	}
	if (!ownsRuntimeCommand(info)) {
		throw new Error(`Refusing to interrupt non-tunnel process in runtime pane ${runtime.paneId}:\n${processText(info)}`);
	}

	scoped(["pane", "send-keys", runtime.paneId, "ctrl+c"]);
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		sleep(POLL_MS);
		info = processInfo(runtime.paneId);
		if (shellIdle(info)) {
			console.log(`Tunnel stopped; persistent runtime shell remains in ${runtime.paneId}.`);
			return;
		}
	}
	throw new Error(`Tunnel did not return to the runtime shell within 10000ms`);
}

function printRuntime(runtime, state = "running") {
	console.log(`Herdr session:   ${SESSION}`);
	console.log(`Runtime:         ${state}`);
	console.log(`Workspace:       ${runtime.workspaceId} (${RUNTIME_LABEL})`);
	console.log(`Pane:            ${runtime.paneId}`);
	console.log(`Terminal:        ${runtime.terminalId}`);
}

const command = process.argv[2] ?? "run";
const takeover = process.argv.slice(3).includes("--takeover");

try {
	switch (command) {
		case "run": {
			assertCanAttachSession();
			withLifecycleLock(() => ensureTunnel());
			process.exitCode = attachSession();
			break;
		}
		case "start": {
			const runtime = withLifecycleLock(() => ensureTunnel());
			printRuntime(runtime);
			break;
		}
		case "attach": {
			const runtime = withLifecycleLock(() => ensureRuntimeWorkspace());
			process.exitCode = attach(runtime, takeover);
			break;
		}
		case "session":
			withLifecycleLock(() => ensureServer());
			process.exitCode = attachSession();
			break;
		case "stop":
			withLifecycleLock(() => stopTunnel());
			break;
		case "info": {
			withLifecycleLock(() => {
				const runtime = ensureRuntimeWorkspace();
				const info = processInfo(runtime.paneId);
				printRuntime(runtime, tunnelActive(info) ? "running" : ownsRuntimeCommand(info) ? "starting" : shellIdle(info) ? "stopped" : "busy");
			});
			break;
		}
		default:
			fail(`Unknown tunnel runtime command: ${command}`);
	}
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
