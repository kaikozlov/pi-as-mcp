/**
 * Bridge between pi's coding tool definitions and MCP tool descriptors.
 *
 * pi ships four "coding" tool definitions (read, write, edit, bash). Each is a
 * {@link ToolDefinition} exposing:
 *   - name / description            -> MCP tool metadata
 *   - parameters (TypeBox schema)   -> MCP inputSchema (TypeBox IS JSON Schema)
 *   - prepareArguments              -> legacy-arg compat shim (edit uses it)
 *   - execute(id, params, signal)   -> returns { content: (TextContent|ImageContent)[] }
 *
 * pi's content blocks are structurally identical to MCP content blocks, so no
 * translation is needed beyond stripping TypeBox's symbol metadata from the
 * schema (done at the call site in index.ts) and normalizing the content union.
 */
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const ALL_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
export type PiToolName = (typeof ALL_TOOL_NAMES)[number];

/** A pi tool definition keyed by the canonical tool name. */
export interface PiTool {
	name: PiToolName;
	definition: ToolDefinition<any, any>;
}

/**
 * Build the requested pi tool definitions bound to `cwd`.
 *
 * The tools resolve relative paths against `cwd` and also accept absolute paths
 * (they are pi's unsandboxed tools). `exposeSessionEnvironment: false` keeps
 * bash from reaching for a session manager / model context that an MCP server
 * does not have.
 */
export function createPiTools(cwd: string, names: readonly PiToolName[]): PiTool[] {
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
			case "bash":
				tools.push({
					name,
					definition: createBashToolDefinition(cwd, { exposeSessionEnvironment: false }),
				});
				break;
		}
	}
	return tools;
}

/**
 * Advisory MCP hints so clients can choose appropriate confirmation UX.
 * read is side-effect free; write/bash can destroy data; bash also touches the
 * outside world.
 */
export const MCP_ANNOTATIONS: Record<PiToolName, Record<string, boolean>> = {
	read: { readOnlyHint: true },
	write: { destructiveHint: true },
	edit: {},
	bash: { openWorldHint: true, destructiveHint: true },
};
