import { expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const BUN = process.execPath;

export function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (
			value !== undefined &&
			!key.startsWith("PI_MCP_") &&
			key !== "CF_ACCESS_TEAM_DOMAIN" &&
			key !== "CF_ACCESS_AUD"
		) {
			env[key] = value;
		}
	}
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

export async function connectStdio(
	args: string[],
	extraEnv: Record<string, string | undefined> = {},
	name = "pi-as-mcp-test",
): Promise<Client> {
	const transport = new StdioClientTransport({
		command: BUN,
		args: ["src/index.ts", ...args],
		env: childEnv(extraEnv),
		stderr: "inherit",
	});
	const client = new Client({ name, version: "0.0.0" });
	await client.connect(transport);
	return client;
}

export function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

export function firstText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const block = content.find(
		(item) =>
			typeof item === "object" &&
			item !== null &&
			(item as { type?: unknown }).type === "text" &&
			typeof (item as { text?: unknown }).text === "string",
	) as { text: string } | undefined;
	return block?.text;
}

export function jsonContent(content: unknown): any {
	const text = firstText(content);
	if (!text) throw new Error("MCP result did not contain JSON text");
	return JSON.parse(text);
}

export async function freePort(): Promise<number> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("ok"),
	});
	const port = server.port;
	await server.stop(true);
	if (!port) throw new Error("Bun.serve did not allocate a port");
	return port;
}

export async function waitForHealth(url: string, process: Bun.Subprocess): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (performance.now() < deadline) {
		if (process.exitCode !== null) {
			throw new Error(`server exited early with code ${process.exitCode}`);
		}
		try {
			if ((await fetch(url)).ok) return;
		} catch {
			// startup race
		}
		await Bun.sleep(50);
	}
	expect(false, `timed out waiting for ${url}`).toBe(true);
}

export async function stopProcess(process: Bun.Subprocess | undefined): Promise<void> {
	if (!process || process.exitCode !== null) return;
	process.kill("SIGTERM");
	await process.exited;
}
