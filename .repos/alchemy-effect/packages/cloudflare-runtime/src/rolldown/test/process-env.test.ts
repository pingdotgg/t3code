import { createMiniflareFromRolldown } from "../../../../cloudflare-test-tools/src/miniflare/miniflare.ts";
import { describe, expect, it } from "vitest";
import { buildFixture } from "./utils/build-fixture.ts";

describe("process.env", async () => {
  const built = await buildFixture({
    fixture: "process-env/index.ts",
  });

  it("responds to fetch /", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });
    expect(await miniflare.fetchText("/")).toBe("ok");
  });

  it("replaces process.env.NODE_ENV with 'production'", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });
    expect(await miniflare.fetchText("/node-env")).toBe("production");
  });

  it("replaces global.process.env.NODE_ENV with 'production'", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });
    expect(await miniflare.fetchText("/global-node-env")).toBe("production");
  });

  it("replaces globalThis.process.env.NODE_ENV with 'production'", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });
    expect(await miniflare.fetchText("/globalthis-node-env")).toBe(
      "production",
    );
  });

  it("does not inject a global process object when only process.env is stubbed", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });
    expect(await miniflare.fetchText("/typeof-process")).toBe("undefined");
  });

  it("defines navigator.userAgent for supported compatibility dates", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });
    expect(await miniflare.fetchText("/user-agent")).toBe("Cloudflare-Workers");
  });
});
