import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
	createBashToolDefinition,
	getShellConfig,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_ROOT = join(tmpdir(), "pi-as-mcp-jobs");

interface ManagedBashInput {
	command?: string;
	timeout?: number;
	session_id?: string;
	kill?: boolean;
}

const LEGACY_SESSION_COMMAND_RE = /^:session\s+([0-9a-f-]{36})(?:\s+(kill))?\s*$/i;

interface JobPaths {
	dir: string;
	command: string;
	log: string;
	pid: string;
	exit: string;
}

interface OutputSnapshot {
	text: string;
	truncated: boolean;
}

function pathsFor(id: string): JobPaths {
	const dir = join(JOB_ROOT, id);
	return {
		dir,
		command: join(dir, "command.sh"),
		log: join(dir, "output.log"),
		pid: join(dir, "pid"),
		exit: join(dir, "exit"),
	};
}

function readOptional(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function readPid(paths: JobPaths): number | undefined {
	const raw = readOptional(paths.pid)?.trim();
	if (!raw) return undefined;
	const pid = Number(raw);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function readExitCode(paths: JobPaths): number | undefined {
	const raw = readOptional(paths.exit)?.trim();
	if (raw === undefined || raw === "") return undefined;
	const code = Number(raw);
	return Number.isInteger(code) ? code : undefined;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function killProcessGroup(pid: number): void {
	if (process.platform === "win32") {
		const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.unref();
		return;
	}

	try {
		process.kill(-pid, "SIGTERM");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ESRCH") throw error;
	}
	setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// The process group already exited.
		}
	}, 1000).unref();
}

function snapshotOutput(path: string): OutputSnapshot {
	let raw: Buffer;
	try {
		raw = readFileSync(path);
	} catch {
		return { text: "", truncated: false };
	}

	let truncated = false;
	if (raw.length > MAX_OUTPUT_BYTES) {
		raw = raw.subarray(raw.length - MAX_OUTPUT_BYTES);
		truncated = true;
	}

	let text = raw.toString("utf8");
	const lines = text.split("\n");
	if (lines.length > MAX_OUTPUT_LINES + 1) {
		text = lines.slice(-(MAX_OUTPUT_LINES + 1)).join("\n");
		truncated = true;
	}
	return { text: text.trimEnd(), truncated };
}

function formatOutput(paths: JobPaths, status: string): string {
	const snapshot = snapshotOutput(paths.log);
	const parts: string[] = [];
	if (snapshot.text) parts.push(snapshot.text);
	parts.push(status);
	if (snapshot.truncated) parts.push(`[Full output: ${paths.log}]`);
	return parts.join("\n\n");
}

function validateSessionId(id: string): void {
	if (!JOB_ID_RE.test(id)) throw new Error(`Invalid bash session_id: ${id}`);
}

function pollJob(id: string, kill: boolean): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	validateSessionId(id);
	const paths = pathsFor(id);
	if (!existsSync(paths.dir)) throw new Error(`Unknown bash session_id: ${id}`);

	let exitCode = readExitCode(paths);
	const pid = readPid(paths);
	if (kill && exitCode === undefined && pid !== undefined && processExists(pid)) {
		killProcessGroup(pid);
		return {
			content: [{
				type: "text",
				text: formatOutput(paths, `[Termination requested for bash session ${id} (pid ${pid}).]`),
			}],
			details: undefined,
		};
	}

	// The wrapper normally writes the exit file itself. If it disappeared before
	// doing so (for example after SIGKILL), report that terminal state rather than
	// claiming forever that the session is still running.
	if (exitCode === undefined && pid !== undefined && !processExists(pid)) {
		exitCode = -1;
	}

	if (exitCode === undefined) {
		const pidText = pid === undefined ? "unknown" : String(pid);
		return {
			content: [{
				type: "text",
				text: formatOutput(
					paths,
					`[Bash session ${id} is still running (pid ${pidText}). Poll with session_id=${id}.]`,
				),
			}],
			details: undefined,
		};
	}

	const status = exitCode === -1
		? `[Bash session ${id} is no longer running; no exit code was recorded.]`
		: `[Bash session ${id} completed with exit code ${exitCode}.]`;
	return { content: [{ type: "text", text: formatOutput(paths, status) }], details: undefined };
}

function waitForExit(child: ChildProcess, ms: number): Promise<"exit" | "yield"> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (result: "exit" | "yield") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			resolve(result);
		};
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("exit", onExit);
			reject(error);
		};
		const onExit = () => finish("exit");
		const timer = setTimeout(() => finish("yield"), ms);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

function spawnJob(command: string, cwd: string): { id: string; paths: JobPaths; child: ChildProcess } {
	mkdirSync(JOB_ROOT, { recursive: true, mode: 0o700 });
	const id = randomUUID();
	const paths = pathsFor(id);
	mkdirSync(paths.dir, { mode: 0o700 });
	writeFileSync(paths.command, command, { encoding: "utf8", mode: 0o700 });
	chmodSync(paths.command, 0o700);

	const shell = getShellConfig();
	const logFd = openSync(paths.log, "a", 0o600);
	// The wrapper writes its own exit status so sessions remain pollable even if
	// pi-as-mcp or the tunnel is restarted while the command is still running.
	const wrapper = `${JSON.stringify(paths.command)}; code=$?; printf '%s\\n' "$code" > ${JSON.stringify(paths.exit)}; exit "$code"`;
	const child = spawn(shell.shell, [...shell.args, wrapper], {
		cwd,
		detached: process.platform !== "win32",
		env: process.env,
		stdio: ["ignore", logFd, logFd],
		windowsHide: true,
	});
	closeSync(logFd);
	if (!child.pid) {
		rmSync(paths.dir, { recursive: true, force: true });
		throw new Error("Failed to start bash command");
	}
	writeFileSync(paths.pid, `${child.pid}\n`, { encoding: "utf8", mode: 0o600 });
	child.unref();
	return { id, paths, child };
}

/**
 * Create a tunnel-safe bash definition. Short commands behave synchronously;
 * commands that exceed maxSyncSeconds keep running as durable local sessions.
 */
export function createManagedBashToolDefinition(cwd: string, maxSyncSeconds: number): ToolDefinition<any, any> {
	const base = createBashToolDefinition(cwd, { exposeSessionEnvironment: false }) as ToolDefinition<any, any>;
	const maxSyncMs = maxSyncSeconds * 1000;

	base.description =
		`Execute a bash command in ${cwd}. Commands that finish within ${maxSyncSeconds} seconds return normally. ` +
		`Longer commands automatically continue in the background and return a session_id; poll them by calling bash with only session_id, ` +
		`or terminate them with session_id plus kill=true. For clients using an older cached tool schema, command=\":session <id>\" polls ` +
		`and command=\":session <id> kill\" terminates the same managed session. The optional timeout is a hard command lifetime in seconds, not the synchronous wait window.`;
	base.promptGuidelines = [
		`Bash automatically yields after ${maxSyncSeconds} seconds instead of killing long-running work. ` +
		"When a call returns a session_id, poll that session with short follow-up bash calls until it completes; tmux is not required. " +
		"If the client has a cached schema without session_id, use command=\":session <id>\" instead.",
	];
	base.parameters = {
		type: "object",
		properties: {
			command: { type: "string", description: "Bash command to execute" },
			timeout: { type: "number", exclusiveMinimum: 0, description: "Optional hard command timeout in seconds" },
			session_id: { type: "string", description: "Existing long-running bash session to poll or terminate" },
			kill: { type: "boolean", description: "With session_id, terminate the running process tree" },
		},
		additionalProperties: false,
		oneOf: [
			{ required: ["command"], not: { required: ["session_id"] } },
			{ required: ["session_id"], not: { required: ["command"] } },
		],
	} as any;

	base.execute = async (_toolCallId, raw: ManagedBashInput, signal) => {
		const legacySession = typeof raw.command === "string" ? raw.command.match(LEGACY_SESSION_COMMAND_RE) : null;
		if (legacySession) {
			if (raw.timeout !== undefined) throw new Error("timeout is only valid when starting a command");
			return pollJob(legacySession[1]!, legacySession[2] === "kill");
		}
		if (raw.session_id !== undefined) {
			if (raw.timeout !== undefined) throw new Error("timeout is only valid when starting a command");
			return pollJob(raw.session_id, raw.kill === true);
		}
		if (raw.kill === true) throw new Error("kill requires session_id");
		if (typeof raw.command !== "string") throw new Error("command is required");
		if (raw.timeout !== undefined && (!Number.isFinite(raw.timeout) || raw.timeout <= 0)) {
			throw new Error("timeout must be a positive number of seconds");
		}
		if (signal?.aborted) throw new Error("Command aborted");

		const { id, paths, child } = spawnJob(raw.command, cwd);
		const pid = child.pid!;
		let timeoutHandle: NodeJS.Timeout | undefined;
		let timedOut = false;
		if (raw.timeout !== undefined) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killProcessGroup(pid);
			}, raw.timeout * 1000);
			timeoutHandle.unref();
		}

		let aborted = false;
		const onAbort = () => {
			aborted = true;
			killProcessGroup(pid);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const result = await waitForExit(child, maxSyncMs);
			if (result === "yield") {
				// The MCP request is complete now. Do not let a later request-context
				// cancellation kill work that was intentionally handed off.
				signal?.removeEventListener("abort", onAbort);
				return {
					content: [{
						type: "text",
						text: formatOutput(
							paths,
							`[Command is still running after ${maxSyncSeconds} seconds. bash session_id=${id}, pid=${pid}. ` +
							`Poll with {"session_id":"${id}"} or cached-schema fallback {"command":":session ${id}"}; ` +
							`terminate with {"session_id":"${id}","kill":true} or {"command":":session ${id} kill"}. Full output: ${paths.log}]`,
						),
					}],
					details: undefined,
				};
			}

			if (timeoutHandle) clearTimeout(timeoutHandle);
			const exitCode = readExitCode(paths);
			const output = snapshotOutput(paths.log);
			const text = output.text || "(no output)";
			if (aborted) throw new Error(`${output.text ? `${output.text}\n\n` : ""}Command aborted`);
			if (timedOut) {
				throw new Error(`${output.text ? `${output.text}\n\n` : ""}Command timed out after ${raw.timeout} seconds`);
			}
			if (exitCode !== 0) {
				throw new Error(`${output.text ? `${output.text}\n\n` : ""}Command exited with code ${exitCode ?? "unknown"}`);
			}
			if (output.truncated) {
				return { content: [{ type: "text", text: `${text}\n\n[Full output: ${paths.log}]` }], details: undefined };
			}
			rmSync(paths.dir, { recursive: true, force: true });
			return { content: [{ type: "text", text }], details: undefined };
		} finally {
			if (child.exitCode !== null && timeoutHandle) clearTimeout(timeoutHandle);
			if (child.exitCode !== null) signal?.removeEventListener("abort", onAbort);
		}
	};

	return base;
}
