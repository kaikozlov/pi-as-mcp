import type { HerdrRuntime } from "./herdr.js";

export type AgentIntegrationState = "current" | "outdated" | "not_installed" | "unknown";

export interface AgentCatalogEntry {
	kind: string;
	integration: AgentIntegrationState;
	integrationVersion?: number;
}

const INTEGRATION_KIND_ALIASES: Readonly<Record<string, string>> = {
	"antigravity-cli": "agy",
};

const AGENT_KIND_LABELS: Readonly<Record<string, string>> = {
	pi: "Pi coding agent",
	omp: "Oh My Pi coding agent",
	codex: "OpenAI Codex coding agent",
	hermes: "Hermes Agent",
	cursor: "Cursor coding agent",
	claude: "Claude Code",
	gemini: "Gemini CLI",
	devin: "Devin CLI",
	agy: "Antigravity CLI",
	cline: "Cline CLI",
	mastracode: "Mastra Code",
	opencode: "OpenCode",
	copilot: "GitHub Copilot CLI",
	kimi: "Kimi Code",
	kiro: "Kiro CLI",
	droid: "Droid",
	amp: "Amp",
	grok: "Grok",
	kilo: "Kilo Code",
	qodercli: "Qoder CLI",
	qwen: "Qwen Code",
	maki: "Maki",
};

interface IntegrationStatusEntry {
	state: AgentIntegrationState;
	version?: number;
}

/** Parse clap's authoritative `--kind` value list from `herdr agent start --help`. */
export function parseHerdrAgentKinds(help: string): string[] {
	const match = help.match(/--kind\s+<KIND>[\s\S]*?\[possible values:\s*([^\]]+)\]/);
	if (!match?.[1]) {
		throw new Error("Could not discover Herdr agent kinds from the `--kind` section of `herdr agent start --help`");
	}
	const kinds = match[1]
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (kinds.length === 0) throw new Error("Herdr reported an empty supported-agent kind list");
	return [...new Set(kinds)];
}

/** Parse the human-oriented but stable one-record-per-line integration status output. */
export function parseHerdrIntegrationStatus(text: string): Map<string, IntegrationStatusEntry> {
	const statuses = new Map<string, IntegrationStatusEntry>();
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^([a-z0-9-]+):\s+(current|outdated|not installed)(?:\s+\(v(\d+)\))?/i);
		if (!match?.[1] || !match[2]) continue;
		const integrationName = match[1].toLowerCase();
		const kind = INTEGRATION_KIND_ALIASES[integrationName] ?? integrationName;
		const rawState = match[2].toLowerCase();
		const state: AgentIntegrationState = rawState === "not installed" ? "not_installed" : rawState as AgentIntegrationState;
		const version = match[3] === undefined ? undefined : Number.parseInt(match[3], 10);
		statuses.set(kind, { state, ...(Number.isFinite(version) ? { version } : {}) });
	}
	return statuses;
}

export function agentKindLabel(kind: string): string {
	return AGENT_KIND_LABELS[kind] ?? `${kind} agent`;
}

export function renderAgentCatalog(entries: readonly AgentCatalogEntry[]): string {
	return entries
		.map((entry) => {
			const integration = entry.integration === "unknown"
				? "no Herdr integration status"
				: `Herdr integration ${entry.integration.replace("_", " ")}${entry.integrationVersion === undefined ? "" : ` v${entry.integrationVersion}`}`;
			return `- ${entry.kind} — ${agentKindLabel(entry.kind)}; ${integration}`;
		})
		.join("\n");
}

/**
 * Discover the installed Herdr binary's supported kinds and lifecycle integration
 * state. REFERENCE/ is deliberately irrelevant to runtime behavior.
 */
export async function discoverAgentCatalog(runtime: HerdrRuntime): Promise<AgentCatalogEntry[]> {
	const [help, integrationText] = await Promise.all([
		runtime.runGlobalText(["agent", "start", "--help"], 5_000).catch(() => ""),
		runtime.runGlobalText(["integration", "status"], 5_000).catch(() => ""),
	]);
	const integrations = parseHerdrIntegrationStatus(integrationText);
	let kinds: string[];
	try {
		kinds = parseHerdrAgentKinds(help);
	} catch (error) {
		kinds = [...integrations.keys()];
		if (kinds.length === 0) throw error;
	}
	return kinds.map((kind) => {
		const integration = integrations.get(kind);
		return {
			kind,
			integration: integration?.state ?? "unknown",
			...(integration?.version === undefined ? {} : { integrationVersion: integration.version }),
		};
	});
}
