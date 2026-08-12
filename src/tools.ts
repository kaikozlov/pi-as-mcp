/**
 * Tool factory for pi-as-mcp.
 *
 * The four core coding tools remain pi's own implementations. When a dedicated
 * Herdr runtime is configured, one additional `agent` tool exposes persistent
 * interactive coding-agent orchestration without moving the agent loop into
 * pi-as-mcp itself.
 */
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { createAgentToolDefinition } from "./agent-tool.js";
import { HerdrRuntime } from "./herdr.js";
import { createManagedBashToolDefinition } from "./managed-bash.js";

export const PI_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
export const ALL_TOOL_NAMES = [...PI_TOOL_NAMES, "agent"] as const;
export type ToolName = (typeof ALL_TOOL_NAMES)[number];

/** A tool definition keyed by its MCP name. */
export interface McpTool {
	name: ToolName;
	definition: ToolDefinition<any, any>;
}

export interface CreateToolsOptions {
	/** Optional synchronous ceiling before long bash work is handed off. */
	bashMaxSyncSeconds?: number;
	/** Dedicated Herdr runtime. Required only when the `agent` tool is enabled. */
	herdr?: HerdrRuntime;
}

/** Build the requested tool definitions bound to `cwd`. */
export function createTools(
	cwd: string,
	names: readonly ToolName[],
	options: CreateToolsOptions = {},
): McpTool[] {
	const wanted = new Set<string>(names);
	const tools: McpTool[] = [];

	for (const name of ALL_TOOL_NAMES) {
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
			case "agent": {
				if (!options.herdr) throw new Error("agent tool requires a configured Herdr runtime");
				tools.push({ name, definition: createAgentToolDefinition(options.herdr, cwd) });
				break;
			}
		}
	}

	return tools;
}

/** Advisory MCP hints for client confirmation/UI behavior. */
export const MCP_ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
	read: {
		readOnlyHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	write: {
		readOnlyHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	edit: {
		readOnlyHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	bash: {
		readOnlyHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	agent: {
		readOnlyHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
};
