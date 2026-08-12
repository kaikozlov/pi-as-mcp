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
	createLocalBashOperations,
	createReadToolDefinition,
	createWriteToolDefinition,
	type BashOperations,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

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

function createCappedBashOperations(maxSyncSeconds: number): BashOperations {
	const local = createLocalBashOperations();
	return {
		exec(command, cwd, options) {
			const timeout = Math.min(options.timeout ?? maxSyncSeconds, maxSyncSeconds);
			return local.exec(command, cwd, { ...options, timeout });
		},
	};
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
				const base = createBashToolDefinition(cwd, {
					exposeSessionEnvironment: false,
					operations: maxSyncSeconds === undefined ? undefined : createCappedBashOperations(maxSyncSeconds),
				});
				if (maxSyncSeconds === undefined) {
					tools.push({ name, definition: base });
					break;
				}

				const longJobGuidance =
					`Synchronous bash calls are capped at ${maxSyncSeconds} seconds in this server. ` +
					"For longer builds, tests, decompilations, or analyses, start the work detached (prefer tmux), " +
					"redirect output and exit status to files, and poll those files with short bash calls.";
				base.description = `${base.description} ${longJobGuidance}`;
				base.promptGuidelines = [...(base.promptGuidelines ?? []), longJobGuidance];
				tools.push({ name, definition: base });
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
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	edit: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false,
	},
	bash: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
};
