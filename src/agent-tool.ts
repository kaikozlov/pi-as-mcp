import { resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { agentKindLabel, renderAgentCatalog, type AgentCatalogEntry } from "./agent-catalog.js";
import { HerdrCommandError, HerdrRuntime } from "./herdr.js";

const MAX_WAIT_MS = 15_000;
const DEFAULT_WAIT_MS = 10_000;
const OUTPUT_LINES = 80;
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_WORKSPACE_LABELS = new Set(["runtime"]);
const SETTLED_STATES = ["idle", "done", "blocked"] as const;
const WAIT_STATES = ["idle", "done", "blocked", "working"] as const;

export const AGENT_TOOL_NAMES = [
	"list_agents",
	"spawn_agent",
	"send_input",
	"wait_agent",
	"read_agent",
	"send_agent_keys",
	"interrupt_agent",
	"close_agent",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

type AgentStatus = "idle" | "done" | "blocked" | "working" | "unknown";
type WaitState = (typeof WAIT_STATES)[number];

interface HerdrAgentInfo {
	name?: string;
	agent?: string;
	agent_status?: AgentStatus;
	cwd?: string;
	foreground_cwd?: string;
	workspace_id?: string;
	interactive_ready?: boolean;
	launch_pending?: boolean;
	state_labels?: Record<string, string>;
}

interface AgentListResponse {
	result?: { agents?: HerdrAgentInfo[] };
}

interface AgentGetResponse {
	result?: { agent?: HerdrAgentInfo };
}

interface WorkspaceCreateResponse {
	result?: {
		workspace?: { workspace_id?: string };
		root_pane?: { pane_id?: string };
	};
}

interface AgentResponse {
	result?: { agent?: HerdrAgentInfo };
}

interface SpawnAgentInput {
	kind?: string;
	message: string;
	name?: string;
	cwd?: string;
	args?: string[];
}

interface TargetMessageInput {
	target: string;
	message: string;
	timeout?: number;
}

interface WaitAgentInput {
	targets: string[];
	mode?: "any" | "all";
	until?: WaitState[];
	timeout?: number;
}

interface ReadAgentInput {
	target: string;
	lines?: number;
	source?: "visible" | "recent" | "recent-unwrapped" | "detection";
}

interface SendKeysInput {
	target: string;
	keys: string[];
}

interface TargetInput {
	target: string;
}

interface CloseAgentInput extends TargetInput {
	force?: boolean;
}

export interface CreateAgentToolsOptions {
	/** Maximum retained Herdr agent workspaces. 0 disables the limit. */
	maxAgents?: number;
	/** Explicit default agent kind. When omitted, prefer omp when installed. */
	defaultAgent?: string;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function jsonResult(value: unknown) {
	return textResult(JSON.stringify(value));
}

function requireNonEmpty(value: string, field: string): string {
	if (!value.trim()) throw new Error(`${field} must not be empty`);
	return value;
}

function validateAgentName(value: string): string {
	if (!AGENT_NAME_RE.test(value)) {
		throw new Error("agent name must match [a-z][a-z0-9_-]{0,31}");
	}
	if (RESERVED_WORKSPACE_LABELS.has(value)) {
		throw new Error(`agent name '${value}' is reserved for pi-as-mcp runtime infrastructure`);
	}
	return value;
}

function parseWaitMs(seconds: number | undefined): number {
	if (seconds === undefined) return DEFAULT_WAIT_MS;
	if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("timeout must be a positive number of seconds");
	return Math.min(Math.round(seconds * 1000), MAX_WAIT_MS);
}

function isHerdrCode(error: unknown, code: string): boolean {
	return error instanceof HerdrCommandError && error.herdrCode === code;
}

function isTimeout(error: unknown): boolean {
	if (isHerdrCode(error, "timeout")) return true;
	return error instanceof HerdrCommandError && `${error.stderr}\n${error.stdout}`.toLowerCase().includes('"code":"timeout"');
}

function herdrErrorSummary(error: unknown) {
	if (!(error instanceof HerdrCommandError)) return { message: error instanceof Error ? error.message : String(error) };
	return {
		...(error.herdrCode ? { code: error.herdrCode } : {}),
		message: error.herdrMessage ?? error.message,
	};
}

function compactAgent(agent: HerdrAgentInfo | undefined) {
	if (!agent) return undefined;
	return {
		name: agent.name,
		kind: agent.agent,
		status: agent.agent_status ?? "unknown",
		cwd: agent.foreground_cwd ?? agent.cwd,
		workspace_id: agent.workspace_id,
		interactive_ready: agent.interactive_ready ?? false,
		launch_pending: agent.launch_pending ?? false,
		...(agent.state_labels && Object.keys(agent.state_labels).length > 0 ? { state_labels: agent.state_labels } : {}),
	};
}

function agentFromResponse(value: AgentResponse | AgentGetResponse): HerdrAgentInfo | undefined {
	return value.result?.agent;
}

async function listAgentInfos(runtime: HerdrRuntime): Promise<HerdrAgentInfo[]> {
	const response = await runtime.runJson<AgentListResponse>(["agent", "list"], 5_000);
	return response.result?.agents ?? [];
}

async function readAgentOutput(
	runtime: HerdrRuntime,
	target: string,
	lines = OUTPUT_LINES,
	source: "visible" | "recent" | "recent-unwrapped" | "detection" = "recent-unwrapped",
): Promise<string | undefined> {
	return runtime.runText(["agent", "read", target, "--source", source, "--lines", String(lines)], 8_000).catch(() => undefined);
}

async function settledPayload(runtime: HerdrRuntime, target: string, agent: HerdrAgentInfo | undefined, extra: Record<string, unknown> = {}) {
	const status = agent?.agent_status ?? "unknown";
	const [output, detection] = await Promise.all([
		readAgentOutput(runtime, target),
		status === "blocked" ? readAgentOutput(runtime, target, 80, "detection") : Promise.resolve(undefined),
	]);
	return {
		...extra,
		agent: compactAgent(agent),
		...(output ? { output } : {}),
		...(detection ? { detection } : {}),
	};
}

async function waitOne(runtime: HerdrRuntime, target: string, waitMs: number, until: readonly WaitState[]) {
	const args = ["agent", "wait", target, "--timeout", String(waitMs)];
	for (const state of until) args.push("--until", state);
	try {
		const response = await runtime.runJson<AgentResponse>(args, waitMs + 2_000);
		return settledPayload(runtime, target, agentFromResponse(response), { timed_out: false });
	} catch (error) {
		if (!isTimeout(error)) throw error;
		const current = await runtime.runJson<AgentGetResponse>(["agent", "get", target], 5_000);
		return settledPayload(runtime, target, agentFromResponse(current), {
			timed_out: true,
			timeout_ms: waitMs,
			retry_after_seconds: 10,
		});
	}
}

async function promptAndWait(runtime: HerdrRuntime, target: string, message: string, waitMs: number) {
	try {
		const response = await runtime.runJson<AgentResponse>(
			["agent", "prompt", target, message, "--wait", "--timeout", String(waitMs)],
			waitMs + 2_000,
		);
		return settledPayload(runtime, target, agentFromResponse(response), { timed_out: false });
	} catch (error) {
		if (isTimeout(error) || isHerdrCode(error, "agent_prompt_stalled")) {
			const current = await runtime.runJson<AgentGetResponse>(["agent", "get", target], 5_000);
			return settledPayload(runtime, target, agentFromResponse(current), {
				timed_out: isTimeout(error),
				prompt_stalled: isHerdrCode(error, "agent_prompt_stalled"),
				timeout_ms: waitMs,
				retry_after_seconds: 10,
			});
		}
		if (isHerdrCode(error, "agent_blocked") || isHerdrCode(error, "agent_not_ready")) {
			const current = await runtime.runJson<AgentGetResponse>(["agent", "get", target], 5_000).catch(() => undefined);
			return settledPayload(runtime, target, current ? agentFromResponse(current) : undefined, {
				prompt_error: herdrErrorSummary(error),
			});
		}
		throw error;
	}
}

function catalogEntriesForModel(catalog: readonly AgentCatalogEntry[]) {
	return catalog.map((entry) => ({
		kind: entry.kind,
		description: agentKindLabel(entry.kind),
		integration: entry.integration,
		...(entry.integrationVersion === undefined ? {} : { integration_version: entry.integrationVersion }),
	}));
}

function chooseAgentName(
	existingAgents: readonly HerdrAgentInfo[],
	reservedNames: ReadonlySet<string>,
	requested: string | undefined,
	kind: string,
): string {
	const existing = new Set(existingAgents.flatMap((agent) => agent.name ? [agent.name] : []));
	const unavailable = (name: string) => existing.has(name) || reservedNames.has(name) || RESERVED_WORKSPACE_LABELS.has(name);
	if (requested !== undefined) {
		const name = validateAgentName(requested);
		if (unavailable(name)) throw new Error(`agent name '${name}' is already in use`);
		return name;
	}
	const base = kind.replace(/[^a-z0-9_-]/g, "-").slice(0, 24) || "agent";
	if (!unavailable(base)) return base;
	for (let index = 2; index < 10_000; index++) {
		const suffix = `-${index}`;
		const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
		if (!unavailable(candidate)) return candidate;
	}
	throw new Error(`could not allocate an agent name for kind ${kind}`);
}

function installedCatalog(catalog: readonly AgentCatalogEntry[]): AgentCatalogEntry[] {
	return catalog.filter((entry) => entry.integration === "current" || entry.integration === "outdated");
}

function installedKinds(catalog: readonly AgentCatalogEntry[]): string[] {
	return installedCatalog(catalog).map((entry) => entry.kind);
}

function commonAnnotationsDescription(catalog: readonly AgentCatalogEntry[], defaultAgent: string): string {
	const installed = installedCatalog(catalog);
	return `Default agent: ${defaultAgent}\nInstalled Herdr agent integrations:\n${renderAgentCatalog(installed)}\nOmit kind to use the default; specify kind only when you have a concrete reason to override it.`;
}

/** Build model-facing subagent tools over the persistent Herdr runtime. */
export function createAgentToolDefinitions(
	runtime: HerdrRuntime,
	baseCwd: string,
	options: CreateAgentToolsOptions = {},
): Array<{ name: AgentToolName; definition: ToolDefinition<any, any> }> {
	const catalog = runtime.getCachedAgentCatalog();
	const kinds = installedKinds(catalog);
	if (kinds.length === 0) throw new Error("No installed Herdr agent integrations were discovered");
	const maxAgents = options.maxAgents ?? 0;
	const configuredDefault = options.defaultAgent?.trim();
	if (configuredDefault && !kinds.includes(configuredDefault)) {
		throw new Error(`Configured default agent '${configuredDefault}' does not have an installed Herdr integration. Available: ${kinds.join(", ")}`);
	}
	const defaultAgent = configuredDefault ?? (kinds.includes("omp") ? "omp" : kinds[0]!);
	const catalogDescription = commonAnnotationsDescription(catalog, defaultAgent);
	const tools: Array<{ name: AgentToolName; definition: ToolDefinition<any, any> }> = [];
	const reservedSpawnNames = new Set<string>();
	let pendingSpawns = 0;

	tools.push({
		name: "list_agents",
		definition: {
			name: "list_agents",
			label: "List Agents",
			description: `List persistent agents and the agent kinds with installed Herdr integrations. ${catalogDescription}`,
			parameters: { type: "object", properties: {}, additionalProperties: false } as any,
			execute: async () => {
				const [agents, freshCatalog] = await Promise.all([listAgentInfos(runtime), runtime.agentCatalog(true)]);
				const installed = installedCatalog(freshCatalog);
				return jsonResult({
					default_agent: defaultAgent,
					kinds: catalogEntriesForModel(installed),
					agents: agents.map(compactAgent),
					counts: {
						total: agents.length,
						working: agents.filter((agent) => agent.agent_status === "working").length,
						blocked: agents.filter((agent) => agent.agent_status === "blocked").length,
					},
					...(maxAgents > 0 ? { max_agents: maxAgents } : {}),
				});
			},
		},
	});

	tools.push({
		name: "spawn_agent",
		definition: {
			name: "spawn_agent",
			label: "Spawn Agent",
			description:
				`Start a persistent coding agent in its own Herdr workspace and immediately submit its first task. ` +
				`The call returns after submission instead of waiting for task completion; use wait_agent to collect results.\n${catalogDescription}`,
			promptGuidelines: [
				`When delegating, omit kind to use the configured default agent (${defaultAgent}); specify a backend only when the user requests one or there is a concrete reason to override the default.`,
				"Delegate genuinely parallel or sidecar work. Keep work that directly blocks your next step local unless delegation provides clear leverage.",
				"Reuse an existing agent with send_input when follow-up work depends on its context instead of spawning a replacement.",
				"For independent work, spawn agents without serially waiting between launches, then use wait_agent with multiple targets. Avoid reflexive polling; continue other useful work when possible.",
			],
			parameters: {
				type: "object",
				required: ["message"],
				properties: {
					kind: { type: "string", enum: kinds, description: `Optional agent kind override; defaults to ${defaultAgent}` },
					message: { type: "string", minLength: 1, description: "Complete initial task for the new agent" },
					name: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$", description: "Optional stable name; generated when omitted" },
					cwd: { type: "string", description: "Working directory; defaults to pi-as-mcp cwd" },
					args: { type: "array", items: { type: "string" }, description: "Native agent CLI arguments passed after --" },
				},
				additionalProperties: false,
			} as any,
			execute: async (_toolCallId, raw: SpawnAgentInput) => {
				const kind = raw.kind === undefined ? defaultAgent : requireNonEmpty(raw.kind, "kind");
				const message = requireNonEmpty(raw.message, "message");
				const [freshCatalog, existingAgents] = await Promise.all([runtime.agentCatalog(true), listAgentInfos(runtime)]);
				const available = installedKinds(freshCatalog);
				if (!available.includes(kind)) {
					throw new Error(`Agent kind '${kind}' does not have an installed Herdr integration. Available: ${available.join(", ") || "none"}`);
				}
				if (maxAgents > 0 && existingAgents.length + pendingSpawns >= maxAgents) {
					throw new Error(
						`agent limit reached (${existingAgents.length + pendingSpawns}/${maxAgents}). Reuse or close an existing agent first: ${existingAgents.flatMap((agent) => agent.name ? [agent.name] : []).join(", ")}`,
					);
				}
				const name = chooseAgentName(existingAgents, reservedSpawnNames, raw.name, kind);
				reservedSpawnNames.add(name);
				pendingSpawns += 1;
				try {
					const cwd = resolve(baseCwd, raw.cwd ?? ".");
					const created = await runtime.runJson<WorkspaceCreateResponse>([
						"workspace", "create", "--cwd", cwd, "--label", name, "--no-focus",
					]);
					const paneId = created.result?.root_pane?.pane_id;
					const workspaceId = created.result?.workspace?.workspace_id;

					let started: AgentResponse;
					try {
						if (!paneId) throw new Error("Herdr workspace creation did not return a root pane id");
						const args = ["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", "15000"];
						if (raw.args?.length) args.push("--", ...raw.args);
						started = await runtime.runJson<AgentResponse>(args, 18_000);
					} catch (error) {
						if (workspaceId) await runtime.runJson(["workspace", "close", workspaceId], 5_000).catch(() => undefined);
						throw error;
					}

					try {
						const prompted = await runtime.runJson<AgentResponse>(["agent", "prompt", name, message], 5_000);
						const output = await readAgentOutput(runtime, name, 40, "visible");
						return jsonResult({
							name,
							kind,
							submitted: true,
							agent: compactAgent(agentFromResponse(prompted) ?? agentFromResponse(started)),
							...(output ? { output } : {}),
						});
					} catch (error) {
						const current = await runtime.runJson<AgentGetResponse>(["agent", "get", name], 5_000).catch(() => undefined);
						const output = await readAgentOutput(runtime, name);
						return jsonResult({
							name,
							kind,
							submitted: false,
							prompt_error: herdrErrorSummary(error),
							agent: compactAgent(current ? agentFromResponse(current) : agentFromResponse(started)),
							...(output ? { output } : {}),
						});
					}
				} finally {
					pendingSpawns -= 1;
					reservedSpawnNames.delete(name);
				}
			},
		},
	});

	tools.push({
		name: "send_input",
		definition: {
			name: "send_input",
			label: "Send Agent Input",
			description: "Send a follow-up task to an existing persistent agent and wait briefly for its next settled state. Reuse an existing agent when the work depends on context it already has.",
			parameters: {
				type: "object",
				required: ["target", "message"],
				properties: {
					target: { type: "string", minLength: 1, description: "Exact agent name from list_agents" },
					message: { type: "string", minLength: 1, description: "Follow-up task or steering message" },
					timeout: { type: "number", exclusiveMinimum: 0, description: `Wait in seconds; capped at ${MAX_WAIT_MS / 1000}` },
				},
				additionalProperties: false,
			} as any,
			execute: async (_toolCallId, raw: TargetMessageInput) =>
				jsonResult(await promptAndWait(runtime, requireNonEmpty(raw.target, "target"), requireNonEmpty(raw.message, "message"), parseWaitMs(raw.timeout))),
		},
	});

	tools.push({
		name: "wait_agent",
		definition: {
			name: "wait_agent",
			label: "Wait Agent",
			description: "Wait for one or more persistent agents. With mode=any, all targets are watched concurrently and the first settled result returns. Prefer one multi-target wait over serial polling, and do not poll when useful independent work remains.",
			parameters: {
				type: "object",
				required: ["targets"],
				properties: {
					targets: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 }, description: "Exact agent names from list_agents" },
					mode: { type: "string", enum: ["any", "all"], description: "any returns the first settled target; all waits on every target; default any" },
					until: { type: "array", uniqueItems: true, items: { type: "string", enum: WAIT_STATES }, description: "Lifecycle states to accept; defaults to idle, done, or blocked" },
					timeout: { type: "number", exclusiveMinimum: 0, description: `Wait in seconds per target; capped at ${MAX_WAIT_MS / 1000}` },
				},
				additionalProperties: false,
			} as any,
			execute: async (_toolCallId, raw: WaitAgentInput) => {
				if (!raw.targets?.length) throw new Error("targets must contain at least one agent name");
				const targets = [...new Set(raw.targets.map((target) => requireNonEmpty(target, "target")))];
				const waitMs = parseWaitMs(raw.timeout);
				const until = raw.until?.length ? raw.until : [...SETTLED_STATES];
				const waits = targets.map(async (target) => ({ target, result: await waitOne(runtime, target, waitMs, until) }));
				if ((raw.mode ?? "any") === "all") {
					return jsonResult({ mode: "all", results: await Promise.all(waits) });
				}
				const winner = await Promise.race(waits);
				void Promise.allSettled(waits);
				return jsonResult({ mode: "any", winner });
			},
		},
	});

	tools.push({
		name: "read_agent",
		definition: {
			name: "read_agent",
			label: "Read Agent",
			description: "Read an agent terminal directly. Normal spawn/send/wait results already include a bounded output tail; use this for deeper inspection or interactive diagnostics.",
			parameters: {
				type: "object",
				required: ["target"],
				properties: {
					target: { type: "string", minLength: 1, description: "Exact agent name from list_agents" },
					lines: { type: "integer", minimum: 1, maximum: 1000, description: "Terminal rows; default 120" },
					source: { type: "string", enum: ["visible", "recent", "recent-unwrapped", "detection"], description: "Herdr terminal source; default recent-unwrapped" },
				},
				additionalProperties: false,
			} as any,
			execute: async (_toolCallId, raw: ReadAgentInput) => textResult(
				await runtime.runText([
					"agent", "read", requireNonEmpty(raw.target, "target"), "--source", raw.source ?? "recent-unwrapped", "--lines", String(raw.lines ?? 120),
				], 10_000),
			),
		},
	});

	tools.push({
		name: "send_agent_keys",
		definition: {
			name: "send_agent_keys",
			label: "Send Agent Keys",
			description: "Low-level escape hatch for an interactive agent UI, such as approvals, login prompts, or questions. Prefer send_input for normal work.",
			parameters: {
				type: "object",
				required: ["target", "keys"],
				properties: {
					target: { type: "string", minLength: 1, description: "Exact agent name from list_agents" },
					keys: { type: "array", minItems: 1, items: { type: "string" }, description: "Logical Herdr terminal keys, e.g. esc or ctrl+c" },
				},
				additionalProperties: false,
			} as any,
			execute: async (_toolCallId, raw: SendKeysInput) => {
				if (!raw.keys?.length) throw new Error("keys must contain at least one logical key");
				return jsonResult(await runtime.runJson(["agent", "send-keys", requireNonEmpty(raw.target, "target"), ...raw.keys], 10_000));
			},
		},
	});

	tools.push({
		name: "interrupt_agent",
		definition: {
			name: "interrupt_agent",
			label: "Interrupt Agent",
			description: "Interrupt an agent's current terminal task with ctrl+c, then observe its next settled state. The workspace and agent remain available for follow-up work.",
			parameters: {
				type: "object",
				required: ["target"],
				properties: { target: { type: "string", minLength: 1, description: "Exact agent name from list_agents" } },
				additionalProperties: false,
			} as any,
			execute: async (_toolCallId, raw: TargetInput) => {
				const target = requireNonEmpty(raw.target, "target");
				const sent = await runtime.runJson(["agent", "send-keys", target, "ctrl+c"], 10_000);
				const state = await waitOne(runtime, target, 3_000, SETTLED_STATES).catch((error) => ({ error: herdrErrorSummary(error) }));
				return jsonResult({ sent, state });
			},
		},
	});

	tools.push({
		name: "close_agent",
		definition: {
			name: "close_agent",
			label: "Close Agent",
			description: "Close a persistent agent and remove its dedicated Herdr workspace. A bounded final terminal tail is captured before removal. Working agents require force=true; prefer interrupt_agent or wait_agent first.",
			parameters: {
				type: "object",
				required: ["target"],
				properties: {
					target: { type: "string", minLength: 1, description: "Exact agent name from list_agents" },
					force: { type: "boolean", description: "Allow closing an agent that is still working; default false" },
				},
				additionalProperties: false,
			} as any,
			execute: async (_toolCallId, raw: CloseAgentInput) => {
				const target = requireNonEmpty(raw.target, "target");
				const current = await runtime.runJson<AgentGetResponse>(["agent", "get", target], 5_000);
				const agent = agentFromResponse(current);
				if (agent?.agent_status === "working" && raw.force !== true) {
					throw new Error(`agent ${target} is still working; wait or interrupt it first, or set force=true`);
				}
				const workspaceId = agent?.workspace_id;
				if (!workspaceId) throw new Error(`Herdr agent ${target} did not report a workspace id`);
				const output = await readAgentOutput(runtime, target, 120);
				if (raw.force !== true) {
					const latest = await runtime.runJson<AgentGetResponse>(["agent", "get", target], 5_000);
					if (agentFromResponse(latest)?.agent_status === "working") {
						throw new Error(`agent ${target} started working while close was being prepared; wait or interrupt it first, or set force=true`);
					}
				}
				const closed = await runtime.runJson(["workspace", "close", workspaceId], 10_000);
				return jsonResult({ previous: compactAgent(agent), ...(output ? { output } : {}), closed });
			},
		},
	});

	return tools;
}
