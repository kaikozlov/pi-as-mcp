/**
 * Bridge between pi's coding tool definitions and MCP tool descriptors.
 *
 * pi ships four default coding tools (read, write, edit, bash). This module
 * creates those exact tool definitions and adds only MCP metadata; execution
 * remains pi's implementation.
 */
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { createManagedBashToolDefinition } from "./managed-bash.js";

export const ALL_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
export type PiToolName = (typeof ALL_TOOL_NAMES)[number];

/** A pi tool definition keyed by its canonical tool name. */
export interface PiTool {
	name: PiToolName;
	definition: ToolDefinition<any, any>;
}

export interface CreatePiToolsOptions {
	/**
	 * Optional ceiling for one synchronous bash invocation. When omitted, pi's
	 * native no-default-timeout behavior is preserved exactly.
	 */
	bashMaxSyncSeconds?: number;
}

/**
 * Build the requested pi tool definitions bound to `cwd`.
 *
 * These are pi's unsandboxed tools: relative paths resolve against `cwd`, while
 * absolute paths are accepted. `exposeSessionEnvironment: false` prevents bash
 * from reaching for a pi session/model context that this MCP server does not
 * have.
 */
export function createPiTools(
	cwd: string,
	names: readonly PiToolName[],
	options: CreatePiToolsOptions = {},
): PiTool[] {
	const wanted = new Set<string>(names);
	const tools: PiTool[] = [];

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
		}
	}

	return tools;
}

/** Advisory MCP hints for client confirmation/UI behavior. */
export const MCP_ANNOTATIONS: Record<PiToolName, ToolAnnotations> = {
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
};
