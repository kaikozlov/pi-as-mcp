import { resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { HerdrCommandError, HerdrRuntime } from "./herdr.js";

const MAX_WAIT_MS = 15_000;
const DEFAULT_WAIT_MS = 10_000;
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

interface AgentToolInput {
	action: "list" | "start" | "prompt" | "wait" | "read" | "send_keys" | "close";
	name?: string;
	target?: string;
	kind?: string;
	cwd?: string;
	args?: string[];
	prompt?: string;
	until?: Array<"idle" | "done" | "blocked" | "working" | "unknown">;
	timeout?: number;
	lines?: number;
	source?: "visible" | "recent" | "recent-unwrapped" | "detection";
	keys?: string[];
}

interface WorkspaceCreateResponse {
	result?: {
		workspace?: { workspace_id?: string };
		root_pane?: { pane_id?: string };
	};
}

interface AgentGetResponse {
	result?: {
		agent?: { workspace_id?: string };
	};
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function jsonResult(value: unknown) {
	return textResult(JSON.stringify(value, null, 2));
}

function requireString(value: string | undefined, field: string): string {
	if (!value) throw new Error(`${field} is required for this agent action`);
	return value;
}

function requireAgentName(value: string | undefined): string {
	const name = requireString(value, "name");
	if (!AGENT_NAME_RE.test(name)) {
		throw new Error("agent name must match [a-z][a-z0-9_-]{0,31}");
	}
	return name;
}

function parseWaitMs(seconds: number | undefined): number {
	if (seconds === undefined) return DEFAULT_WAIT_MS;
	if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("timeout must be a positive number of seconds");
	return Math.min(Math.round(seconds * 1000), MAX_WAIT_MS);
}

function isTimeout(error: unknown): boolean {
	if (!(error instanceof HerdrCommandError)) return false;
	return `${error.stderr}\n${error.stdout}\n${error.message}`.toLowerCase().includes("timeout");
}

function isPaneBusy(error: unknown): boolean {
	if (!(error instanceof HerdrCommandError)) return false;
	return `${error.stderr}\n${error.stdout}\n${error.message}`.includes("agent_pane_busy");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One compact MCP surface over Herdr's persistent agent runtime. */
export function createAgentToolDefinition(runtime: HerdrRuntime, baseCwd: string): ToolDefinition<any, any> {
	return {
		name: "agent",
		label: "Agent",
		description:
			`Control persistent coding agents in pi-as-mcp's dedicated Herdr session (${runtime.session}). ` +
			"Use start to launch an agent in its own workspace, prompt to submit work with an atomic tunnel-safe lifecycle wait, wait to observe later lifecycle state, " +
			"read to inspect terminal output, send_keys for interactive controls, close to terminate and remove a finished agent workspace, and list to inspect all managed agents.",
		promptGuidelines: [
			"Use the agent tool for persistent interactive coding-agent work; use bash for ordinary commands, builds, tests, and scripts.",
			"Prompt waits atomically for a settled lifecycle state for at most the tunnel-safe timeout; if it times out, the agent keeps running and later wait/read calls can follow it.",
			"Inspect the visible output returned by start before prompting when an agent may be showing a trust, approval, login, or question UI.",
		],
		parameters: {
			type: "object",
			required: ["action"],
			properties: {
				action: {
					type: "string",
					enum: ["list", "start", "prompt", "wait", "read", "send_keys", "close"],
					description: "Agent operation to perform",
				},
				name: { type: "string", description: "Unique name for a newly started agent" },
				target: { type: "string", description: "Existing agent name or Herdr pane id" },
				kind: { type: "string", description: "Herdr-supported agent kind, such as codex, claude, pi, or hermes" },
				cwd: { type: "string", description: "Working directory for a newly started agent; defaults to pi-as-mcp cwd" },
				args: { type: "array", items: { type: "string" }, description: "Native agent arguments passed after --" },
				prompt: { type: "string", description: "Prompt text to submit to an existing agent using Herdr's atomic prompt+wait" },
				until: {
					type: "array",
					items: { type: "string", enum: ["idle", "done", "blocked", "working", "unknown"] },
					description: "Exact lifecycle states accepted by wait; omitted uses Herdr's settled defaults",
				},
				timeout: {
					type: "number",
					exclusiveMinimum: 0,
					description: `Wait duration in seconds, capped at ${MAX_WAIT_MS / 1000} to stay tunnel-safe`,
				},
				lines: { type: "integer", minimum: 1, maximum: 1000, description: "Terminal rows to read; default 120" },
				source: {
					type: "string",
					enum: ["visible", "recent", "recent-unwrapped", "detection"],
					description: "Herdr terminal read source; default recent-unwrapped",
				},
				keys: { type: "array", minItems: 1, items: { type: "string" }, description: "Logical terminal keys, e.g. esc or ctrl+c" },
			},
			additionalProperties: false,
		} as any,
		execute: async (_toolCallId, raw: AgentToolInput) => {
			switch (raw.action) {
				case "list":
					return jsonResult(await runtime.runJson(["agent", "list"]));

				case "start": {
					const name = requireAgentName(raw.name);
					const kind = requireString(raw.kind, "kind");
					const cwd = resolve(baseCwd, raw.cwd ?? ".");
					const created = await runtime.runJson<WorkspaceCreateResponse>([
						"workspace",
						"create",
						"--cwd",
						cwd,
						"--label",
						name,
						"--no-focus",
					]);
					const paneId = created.result?.root_pane?.pane_id;
					const workspaceId = created.result?.workspace?.workspace_id;
					if (!paneId) throw new Error("Herdr workspace creation did not return a root pane id");

					try {
						const args = ["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", "15000"];
						if (raw.args?.length) args.push("--", ...raw.args);
						const shellReadyDeadline = Date.now() + 5_000;
						let started: unknown;
						while (true) {
							try {
								started = await runtime.runJson(args, 18_000);
								break;
							} catch (error) {
								if (!isPaneBusy(error) || Date.now() >= shellReadyDeadline) throw error;
								await sleep(100);
							}
						}
						const visible = await runtime
							.runText(["agent", "read", name, "--source", "visible"], 5_000)
							.catch(() => undefined);
						return jsonResult({ started, visible });
					} catch (error) {
						if (workspaceId) {
							await runtime.runJson(["workspace", "close", workspaceId], 5_000).catch(() => undefined);
						}
						throw error;
					}
				}

				case "prompt": {
					const target = requireString(raw.target, "target");
					const prompt = requireString(raw.prompt, "prompt");
					const waitMs = parseWaitMs(raw.timeout);
					try {
						return jsonResult(
							await runtime.runJson(
								["agent", "prompt", target, prompt, "--wait", "--timeout", String(waitMs)],
								waitMs + 2_000,
							),
						);
					} catch (error) {
						if (!isTimeout(error)) throw error;
						const current = await runtime.runJson(["agent", "get", target], 5_000);
						return jsonResult({ timed_out: true, timeout_ms: waitMs, current });
					}
				}

				case "wait": {
					const target = requireString(raw.target, "target");
					const waitMs = parseWaitMs(raw.timeout);
					const args = ["agent", "wait", target, "--timeout", String(waitMs)];
					for (const state of raw.until ?? []) args.push("--until", state);
					try {
						return jsonResult(await runtime.runJson(args, waitMs + 2_000));
					} catch (error) {
						if (!isTimeout(error)) throw error;
						const current = await runtime.runJson(["agent", "get", target], 5_000);
						return jsonResult({ timed_out: true, timeout_ms: waitMs, current });
					}
				}

				case "read": {
					const target = requireString(raw.target, "target");
					const lines = raw.lines ?? 120;
					const source = raw.source ?? "recent-unwrapped";
					return textResult(
						await runtime.runText(["agent", "read", target, "--source", source, "--lines", String(lines)], 10_000),
					);
				}

				case "send_keys": {
					const target = requireString(raw.target, "target");
					if (!raw.keys?.length) throw new Error("keys is required for send_keys");
					return jsonResult(await runtime.runJson(["agent", "send-keys", target, ...raw.keys], 10_000));
				}

				case "close": {
					const target = requireString(raw.target, "target");
					const current = await runtime.runJson<AgentGetResponse>(["agent", "get", target], 5_000);
					const workspaceId = current.result?.agent?.workspace_id;
					if (!workspaceId) throw new Error(`Herdr agent ${target} did not report a workspace id`);
					return jsonResult(await runtime.runJson(["workspace", "close", workspaceId], 10_000));
				}
			}
		},
	};
}
