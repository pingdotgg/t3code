import { afterEach, expect, it, vi } from "@effect/vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("does not redirect GitCafe operations through the former process override", async () => {
  vi.stubEnv("T3CODE_GITCAFE_API_BASE_URL", "https://staging.git.cafe/api");
  vi.resetModules();
  const cli = await import("./GitCafeCli.ts");
  const { discovery } = await import("./GitCafeSourceControlProvider.ts");
  expect(cli.HOST).toBe("https://git.cafe/api");
  expect(discovery.authArgs).toEqual([...cli.CLI_ARGS, "auth", "status", "--json"]);
});
