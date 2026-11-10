import { createRemoteJWKSet, jwtVerify } from "jose";

export interface CloudflareAccessConfig {
	teamDomain: string;
	audience: string;
}

function normalizeTeamDomain(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("CF_ACCESS_TEAM_DOMAIN is required for Cloudflare Access auth");
	const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
	if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
		throw new Error("CF_ACCESS_TEAM_DOMAIN must use https");
	}
	return url.origin;
}

export function parseCloudflareAccessConfig(env: NodeJS.ProcessEnv): CloudflareAccessConfig {
	const audience = env.CF_ACCESS_AUD?.trim();
	if (!audience) throw new Error("CF_ACCESS_AUD is required for Cloudflare Access auth");
	return {
		teamDomain: normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN ?? ""),
		audience,
	};
}

export function createCloudflareAccessGuard(config: CloudflareAccessConfig) {
	const teamDomain = normalizeTeamDomain(config.teamDomain);
	const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));

	return async (request: Request): Promise<Response | undefined> => {
		const token = request.headers.get("cf-access-jwt-assertion");
		if (!token) {
			return Response.json({ error: "missing Cloudflare Access JWT" }, { status: 403 });
		}

		try {
			await jwtVerify(token, jwks, {
				issuer: teamDomain,
				audience: config.audience,
			});
			return undefined;
		} catch (error) {
			const detail = error as {
				name?: string;
				code?: string;
				claim?: string;
				reason?: string;
				message?: string;
			};
			process.stderr.write(`${JSON.stringify({
				event: "cloudflare_access_verify_failed",
				name: detail.name,
				code: detail.code,
				claim: detail.claim,
				reason: detail.reason,
				message: detail.message,
			})}\n`);
			return Response.json({ error: "invalid Cloudflare Access JWT" }, { status: 403 });
		}
	};
}
