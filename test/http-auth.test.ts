import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { BUN, childEnv, freePort, stopProcess, waitForHealth } from "./helpers";

setDefaultTimeout(15_000);

describe("Cloudflare Access authentication", () => {
	let cwd: string;
	let issuer: string;
	let audience: string;
	let kid: string;
	let privateKey: CryptoKey;
	let base: string;
	let jwksServer: Bun.Server<undefined>;
	let mcpServer: Bun.Subprocess;

	async function signToken(tokenAudience: string): Promise<string> {
		return new SignJWT({ email: "kai@example.test" })
			.setProtectedHeader({ alg: "RS256", kid })
			.setIssuer(issuer)
			.setAudience(tokenAudience)
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
	}

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "pi-mcp-http-auth-"));
		audience = "pi-as-mcp-auth-test";
		kid = "auth-test-key";

		const keys = await generateKeyPair("RS256");
		privateKey = keys.privateKey;
		const jwk = await exportJWK(keys.publicKey);
		jwk.kid = kid;
		jwk.alg = "RS256";
		jwk.use = "sig";

		jwksServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			routes: {
				"/cdn-cgi/access/certs": Response.json({ keys: [jwk] }),
			},
			fetch: () => new Response("Not Found", { status: 404 }),
		});
		issuer = jwksServer.url.origin;

		const mcpPort = await freePort();
		base = `http://127.0.0.1:${mcpPort}`;
		mcpServer = Bun.spawn([
			BUN,
			"src/index.ts",
			"--transport", "http",
			"--auth", "cloudflare-access",
			"--host", "127.0.0.1",
			"--port", String(mcpPort),
			"--cwd", cwd,
		], {
			env: childEnv({
				CF_ACCESS_TEAM_DOMAIN: issuer,
				CF_ACCESS_AUD: audience,
			}),
			stdout: "ignore",
			stderr: "inherit",
		});

		await waitForHealth(`${base}/healthz`, mcpServer);
	});

	afterAll(async () => {
		await stopProcess(mcpServer);
		await jwksServer?.stop(true);
		if (cwd) await rm(cwd, { recursive: true, force: true });
	});

	test("rejects requests without an Access assertion", async () => {
		const response = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect(response.status).toBe(403);
	});

	test("rejects an Access assertion for the wrong audience", async () => {
		const response = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-access-jwt-assertion": await signToken("wrong-audience"),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect(response.status).toBe(403);
	});

	test("accepts a valid Access assertion", async () => {
		const client = new Client({ name: "test-http-auth", version: "0.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
			requestInit: {
				headers: { "Cf-Access-Jwt-Assertion": await signToken(audience) },
			},
		});

		try {
			await client.connect(transport);
			const listed = await client.listTools();
			expect(listed.tools.some((tool) => tool.name === "bash")).toBe(true);
		} finally {
			await client.close().catch(() => undefined);
		}
	});
});
