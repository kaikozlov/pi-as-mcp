for (const key of Object.keys(process.env)) {
	if (key.startsWith("PI_MCP_") || key === "CF_ACCESS_TEAM_DOMAIN" || key === "CF_ACCESS_AUD") {
		delete process.env[key];
	}
}
