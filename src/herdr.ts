import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_MS = 100;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const SESSION_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

interface SessionInfo {
	name: string;
	running: boolean;
	socket_path?: string;
}

interface SessionListResponse {
	sessions?: SessionInfo[];
}

export interface HerdrRuntimeOptions {
	session: string;
	cwd: string;
	binary?: string;
	startupTimeoutMs?: number;
}

export class HerdrCommandError extends Error {
	readonly stderr: string;
	readonly stdout: string;
	readonly code: string | number | null | undefined;

	constructor(message: string, options: { stderr?: string; stdout?: string; code?: string | number | null }) {
		super(message);
		this.name = "HerdrCommandError";
		this.stderr = options.stderr ?? "";
		this.stdout = options.stdout ?? "";
		this.code = options.code;
	}
}

function validateSessionName(name: string): void {
	if (name === "default") {
		throw new Error("pi-as-mcp requires a dedicated named Herdr session; 'default' is not allowed");
	}
	if (name === "." || name === ".." || !SESSION_NAME_RE.test(name)) {
		throw new Error(
			"Herdr session name must be 1-64 ASCII letters, numbers, '.', '_' or '-', and cannot be '.' or '..'",
		);
	}
}

function sanitizedHerdrEnv(): NodeJS.ProcessEnv {
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
	]) {
		delete env[key];
	}
	return env;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorDetail(error: unknown): HerdrCommandError {
	const value = error as NodeJS.ErrnoException & {
		stdout?: string | Buffer;
		stderr?: string | Buffer;
		code?: string | number | null;
	};
	const stdout = value.stdout?.toString() ?? "";
	const stderr = value.stderr?.toString() ?? "";
	const detail = stderr.trim() || stdout.trim() || value.message || String(error);
	return new HerdrCommandError(detail, { stdout, stderr, code: value.code });
}

function serverNotRunning(error: HerdrCommandError): boolean {
	const combined = `${error.stderr}\n${error.stdout}\n${error.message}`.toLowerCase();
	return combined.includes("server_not_running") || combined.includes("server is not running");
}

/**
 * Owns access to one explicit named Herdr session.
 *
 * Every invocation uses `--session`, and inherited Herdr caller variables are
 * stripped, so a pi-as-mcp process launched from another Herdr session cannot
 * accidentally operate on that caller session.
 */
export class HerdrRuntime {
	readonly session: string;
	readonly cwd: string;
	readonly binary: string;
	readonly startupTimeoutMs: number;
	private readyPromise: Promise<void> | undefined;

	constructor(options: HerdrRuntimeOptions) {
		validateSessionName(options.session);
		this.session = options.session;
		this.cwd = options.cwd;
		this.binary = options.binary?.trim() || "herdr";
		this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
	}

	async ensureReady(): Promise<void> {
		if (!this.readyPromise) {
			this.readyPromise = this.ensureReadyOnce().catch((error) => {
				this.readyPromise = undefined;
				throw error;
			});
		}
		return this.readyPromise;
	}

	async runJson<T = unknown>(args: readonly string[], timeoutMs = 20_000): Promise<T> {
		const stdout = await this.run(args, timeoutMs);
		try {
			return JSON.parse(stdout) as T;
		} catch (error) {
			throw new Error(
				`Herdr returned invalid JSON for ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async runText(args: readonly string[], timeoutMs = 20_000): Promise<string> {
		return (await this.run(args, timeoutMs)).trimEnd();
	}

	private async run(args: readonly string[], timeoutMs: number): Promise<string> {
		await this.ensureReady();
		try {
			return await this.exec(args, timeoutMs);
		} catch (error) {
			const commandError = error instanceof HerdrCommandError ? error : errorDetail(error);
			if (!serverNotRunning(commandError)) throw commandError;
			this.readyPromise = undefined;
			await this.ensureReady();
			return this.exec(args, timeoutMs);
		}
	}

	private async ensureReadyOnce(): Promise<void> {
		const info = await this.sessionInfo();
		if (info?.running) {
			await this.exec(["api", "snapshot"], 5_000);
			return;
		}

		this.spawnServer();
		const deadline = Date.now() + this.startupTimeoutMs;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				const current = await this.sessionInfo();
				if (current?.running) {
					await this.exec(["api", "snapshot"], 5_000);
					return;
				}
			} catch (error) {
				lastError = error;
			}
			await sleep(STARTUP_POLL_MS);
		}

		const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
		throw new Error(`Herdr session ${this.session} did not become ready within ${this.startupTimeoutMs}ms${suffix}`);
	}

	private async sessionInfo(): Promise<SessionInfo | undefined> {
		const raw = await this.execUnscoped(["session", "list", "--json"], 5_000);
		let parsed: SessionListResponse;
		try {
			parsed = JSON.parse(raw) as SessionListResponse;
		} catch (error) {
			throw new Error(`Could not parse Herdr session list: ${error instanceof Error ? error.message : String(error)}`);
		}
		return parsed.sessions?.find((session) => session.name === this.session);
	}

	private spawnServer(): void {
		const child = spawn(this.binary, ["--session", this.session, "server"], {
			cwd: this.cwd,
			detached: true,
			env: sanitizedHerdrEnv(),
			stdio: "ignore",
			windowsHide: true,
		});
		child.once("error", () => {
			// Readiness polling will surface a deterministic startup failure.
		});
		child.unref();
	}

	private async exec(args: readonly string[], timeoutMs: number): Promise<string> {
		return this.execUnscoped(["--session", this.session, ...args], timeoutMs);
	}

	private async execUnscoped(args: readonly string[], timeoutMs: number): Promise<string> {
		try {
			const { stdout } = await execFileAsync(this.binary, [...args], {
				cwd: this.cwd,
			env: sanitizedHerdrEnv(),
			encoding: "utf8",
			maxBuffer: MAX_BUFFER_BYTES,
			timeout: timeoutMs,
			windowsHide: true,
		});
			return stdout;
		} catch (error) {
			throw errorDetail(error);
		}
	}
}
