import type { NextFunction, Request, Response } from "express";
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

export function createCloudflareAccessMiddleware(config: CloudflareAccessConfig) {
	const teamDomain = normalizeTeamDomain(config.teamDomain);
	const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));

	return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
		const token = req.header("cf-access-jwt-assertion");
		if (!token) {
			res.status(403).json({ error: "missing Cloudflare Access JWT" });
			return;
		}

		try {
			const { payload } = await jwtVerify(token, jwks, {
				issuer: teamDomain,
				audience: config.audience,
			});
			res.locals.cloudflareAccess = payload;
			next();
		} catch (error) {
			const detail = error as { name?: string; code?: string; claim?: string; reason?: string; message?: string };
			process.stderr.write(`${JSON.stringify({ event: "cloudflare_access_verify_failed", name: detail.name, code: detail.code, claim: detail.claim, reason: detail.reason, message: detail.message })}\n`);
			res.status(403).json({ error: "invalid Cloudflare Access JWT" });
		}
	};
}
