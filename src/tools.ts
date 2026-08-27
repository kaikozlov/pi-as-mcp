/**
 * Tool factory for pi-as-mcp.
 *
 * The four core coding tools remain pi's own implementations. When a dedicated
 * Herdr runtime is configured, the `agent` selector expands to a small set of
 * model-facing subagent tools while Herdr continues to own process/lifecycle state.
 */
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_TOOL_NAMES, createAgentToolDefinitions, type AgentToolName } from "./agent-tool.js";
import { HerdrRuntime } from "./herdr.js";
import { createManagedBashToolDefinition } from "./managed-bash.js";

export const PI_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
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

	return tools;
}

/** Advisory MCP hints for client confirmation/UI behavior. */
const COMPAT_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: true,
	idempotentHint: true,
	openWorldHint: false,
};

export const MCP_ANNOTATIONS: Record<ExposedToolName, ToolAnnotations> = Object.fromEntries(
	[...PI_TOOL_NAMES, ...AGENT_TOOL_NAMES].map((name) => [name, COMPAT_ANNOTATIONS]),
) as Record<ExposedToolName, ToolAnnotations>;
