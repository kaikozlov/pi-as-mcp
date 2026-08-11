import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const assert = (cond, msg) => {
	if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
};

async function freePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise((resolve) => server.close(resolve));
	if (!port) throw new Error("failed to allocate test port");
	return port;
}

async function waitForHealth(url, child) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`HTTP server exited early with ${child.exitCode}`);
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {
			// startup race
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("timed out waiting for HTTP server");
}

async function signToken(privateKey, issuer, audience, kid) {
	return await new SignJWT({ email: "kai@example.test" })
		.setProtectedHeader({ alg: "RS256", kid })
		.setIssuer(issuer)
		.setAudience(audience)
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);
}

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-http-auth-"));
	const jwksPort = await freePort();
	const mcpPort = await freePort();
	const issuer = `http://127.0.0.1:${jwksPort}`;
	const audience = "pi-as-mcp-auth-smoke";
	const kid = "auth-smoke-key";
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const jwk = await exportJWK(publicKey);
	jwk.kid = kid;
	jwk.alg = "RS256";
	jwk.use = "sig";

	const jwksServer = createServer((req, res) => {
		if (req.url === "/cdn-cgi/access/certs") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ keys: [jwk] }));
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise((resolve, reject) => {
		jwksServer.once("error", reject);
		jwksServer.listen(jwksPort, "127.0.0.1", resolve);
	});

	const child = spawn(process.execPath, [
		"dist/index.js",
		"--transport", "http",
		"--auth", "cloudflare-access",
		"--host", "127.0.0.1",
		"--port", String(mcpPort),
		"--cwd", cwd,
	], {
		env: {
			...process.env,
			CF_ACCESS_TEAM_DOMAIN: issuer,
			CF_ACCESS_AUD: audience,
		},
		stdio: ["ignore", "pipe", "inherit"],
	});

	try {
		const base = `http://127.0.0.1:${mcpPort}`;
		await waitForHealth(`${base}/healthz`, child);

		const noToken = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		assert(noToken.status === 403, `missing token status ${noToken.status}, want 403`);

		const wrongAudience = await signToken(privateKey, issuer, "wrong-audience", kid);
		const badToken = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-access-jwt-assertion": wrongAudience,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		assert(badToken.status === 403, `wrong-audience status ${badToken.status}, want 403`);

		const token = await signToken(privateKey, issuer, audience, kid);
		const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
			requestInit: {
				headers: { "Cf-Access-Jwt-Assertion": token },
			},
		});
		const client = new Client({ name: "http-auth-smoke", version: "0.0.0" });
		try {
			await client.connect(transport);
			const listed = await client.listTools();
			assert(listed.tools.some((tool) => tool.name === "bash"), "authenticated MCP session did not list bash");
		} finally {
			await client.close().catch(() => undefined);
		}

		console.log("PASS: Cloudflare Access JWT auth rejects missing/wrong assertions and accepts a valid signed assertion");
	} finally {
		child.kill("SIGTERM");
		await new Promise((resolve) => child.once("exit", resolve)).catch(() => undefined);
		await new Promise((resolve) => jwksServer.close(resolve));
		await rm(cwd, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
