import { expect, test } from "bun:test";

test("operator shell scripts parse", () => {
	const result = Bun.spawnSync(["bash", "-n", "scripts/setup.sh", "scripts/service.sh"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
});
