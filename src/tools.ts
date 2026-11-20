/**
 * Tool factory for pi-as-mcp.
 *
 * The four core coding tools remain pi's own implementations. When a dedicated
 * Herdr runtime is configured, the `agent` selector expands to a small set of
 * model-facing subagent tools while Herdr continues to own process/lifecycle state.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
	createBashToolDefinition,
	createCodemodeExtension,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	SessionManager,
	type ExtensionAPI,
	type ToolDefinition,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { AGENT_TOOL_NAMES, createAgentToolDefinitions, type AgentToolName } from "./agent-tool.js";
import { HerdrRuntime } from "./herdr.js";
import { createManagedBashToolDefinition } from "./managed-bash.js";

export const PI_TOOL_NAMES = ["read", "write", "edit", "bash", "codemode"] as const;
export const TOOL_SELECTORS = [...PI_TOOL_NAMES, "agent", ...AGENT_TOOL_NAMES] as const;
export type ToolSelector = (typeof TOOL_SELECTORS)[number];
export type ExposedToolName = (typeof PI_TOOL_NAMES)[number] | AgentToolName;

/** A tool definition keyed by its MCP name. */
export interface McpTool {
	name: ExposedToolName;
	definition: ToolDefinition<any, any>;
}

export interface CreateToolsOptions {
	/** Optional synchronous ceiling before long bash work is handed off. */
	bashMaxSyncSeconds?: number;
	/** Dedicated Herdr runtime. Required when any agent selector is enabled. */
	herdr?: HerdrRuntime;
	/** Maximum retained agent workspaces; 0 disables the limit. */
	maxAgents?: number;
	/** Explicit default agent kind; createAgentToolDefinitions prefers omp when omitted. */
	defaultAgent?: string;
}

function wantsAnyAgentTool(names: readonly ToolSelector[]): boolean {
	return names.includes("agent") || AGENT_TOOL_NAMES.some((name) => names.includes(name));
}

/** Build the requested tool definitions bound to `cwd`. */
export function createTools(
	cwd: string,
	names: readonly ToolSelector[],
	options: CreateToolsOptions = {},
): McpTool[] {
	const wanted = new Set<string>(names);
	const tools: McpTool[] = [];

	for (const name of PI_TOOL_NAMES) {
		if (!wanted.has(name)) continue;
		switch (name) {
			case "read":
				tools.push({ name, definition: createReadToolDefinition(cwd) });
				break;
			case "write":
				tools.push({ name, definition: createWriteToolDefinition(cwd) });
				break;
			case "edit":
				tools.push({ name, definition: createEditToolDefinition(cwd) });
				break;
			case "bash": {
				const maxSyncSeconds = options.bashMaxSyncSeconds;
				const definition = maxSyncSeconds === undefined
					? createBashToolDefinition(cwd, { exposeSessionEnvironment: false })
					: createManagedBashToolDefinition(cwd, maxSyncSeconds);
				tools.push({ name, definition });
				break;
			}
		}
	}

	if (wantsAnyAgentTool(names)) {
		if (!options.herdr) throw new Error("agent tools require a configured Herdr runtime");
		const allAgentTools = createAgentToolDefinitions(options.herdr, cwd, { maxAgents: options.maxAgents, defaultAgent: options.defaultAgent });
		for (const tool of allAgentTools) {
			if (wanted.has("agent") || wanted.has(tool.name)) tools.push(tool);
		}
	}

	if (wanted.has("codemode")) {
		const sessions = new AsyncLocalStorage<SessionManager>();
		const available: ToolInfo[] = tools.map(({ name, definition }) => ({
			name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			exposure: "direct",
			sourceInfo: { path: import.meta.path, source: "pi-as-mcp", scope: "temporary", origin: "top-level" },
		}));
		const registered: McpTool["definition"][] = [];
		const api = {
			registerTool: (tool) => { registered.push(tool); },
			getAllTools: () => available,
			appendEntry(type, data) {
				const session = sessions.getStore();
				if (!session) throw new Error("No active Code Mode call.");
				session.appendCustomEntry(type, data);
			},
		} satisfies Pick<ExtensionAPI, "registerTool" | "getAllTools" | "appendEntry">;
		createCodemodeExtension({ models: false, mode: "on" })(api as ExtensionAPI);
		const [definition] = registered;
		if (!definition) throw new Error("Pi did not register codemode.");
		definition.description = definition.description
			.replace("The input is raw JavaScript (not JSON, no code fence), run", "Put JavaScript in the `code` argument without code fences. The code runs")
			.replace("keep JSON values across codemode calls.", "keep JSON values in the current script.");
		const execute = definition.execute;
		definition.execute = (id, args, signal, onUpdate, context) => {
			// Keep Pi's store isolated to this MCP call.
			const sessionManager = SessionManager.inMemory(cwd);
			return sessions.run(sessionManager, () => execute(id, args, signal, onUpdate, { ...context, sessionManager }));
		};
		tools.push({ name: "codemode", definition });
	}

	return tools;
}

const READ_ONLY: ToolAnnotations = { openWorldHint: false };
const LOCAL_MUTATION: ToolAnnotations = {
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: false,
};
const OPEN_WORLD_MUTATION: ToolAnnotations = { ...LOCAL_MUTATION, openWorldHint: true };

export const MCP_ANNOTATIONS: Record<ExposedToolName, ToolAnnotations> = {
	read: READ_ONLY,
	write: LOCAL_MUTATION,
	edit: LOCAL_MUTATION,
	bash: OPEN_WORLD_MUTATION,
	codemode: OPEN_WORLD_MUTATION,
	list_agents: READ_ONLY,
	spawn_agent: OPEN_WORLD_MUTATION,
	send_input: OPEN_WORLD_MUTATION,
	wait_agent: READ_ONLY,
	read_agent: READ_ONLY,
	send_agent_keys: OPEN_WORLD_MUTATION,
	interrupt_agent: LOCAL_MUTATION,
	close_agent: LOCAL_MUTATION,
};
