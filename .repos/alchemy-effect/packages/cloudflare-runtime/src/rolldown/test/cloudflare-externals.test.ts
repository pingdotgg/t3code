import { createMiniflareFromRolldown } from "../../../../cloudflare-test-tools/src/miniflare/miniflare.ts";
import type { ResolveIdResult } from "rolldown";
import { describe, expect, it } from "vitest";
import { cloudflareExternalsPlugin } from "../plugins/cloudflare-externals.ts";
import { buildFixture } from "./utils/build-fixture.ts";

describe("cloudflare externals", () => {
  it("marks supported cloudflare:* builtins as external", () => {
    const resolved = (
      cloudflareExternalsPlugin.rolldown({}).resolveId as {
        handler: (id: string) => ResolveIdResult;
      }
    ).handler("cloudflare:workers");

    expect(resolved).toEqual({
      id: "cloudflare:workers",
      external: true,
    });
  });

  it("ignores unknown cloudflare:* imports", () => {
    expect(
      (
        cloudflareExternalsPlugin.rolldown({}).resolveId as {
          handler: (id: string) => ResolveIdResult;
        }
      ).handler("cloudflare:unknown"),
    ).toBeUndefined();
  });

  it("keeps Cloudflare builtin imports working at runtime", async () => {
    const built = await buildFixture({
      fixture: "cloudflare-imports/index.ts",
    });

    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    const result = await miniflare.fetchJson<Record<string, string>>("/");
    expect(result["(cloudflare:workers) WorkerEntrypoint.name"]).toBe(
      "WorkerEntrypoint",
    );
    expect(["DurableObject", "DurableObjectBase"]).toContain(
      result["(cloudflare:workers) DurableObject.name"],
    );
    expect(result["(cloudflare:sockets) typeof connect"]).toBe("function");
  });

  it("keeps externalized Cloudflare builtins working through dependencies", async () => {
    const built = await buildFixture({
      fixture: "cloudflare-imports/index.ts",
    });

    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    const result =
      await miniflare.fetchJson<Record<string, string>>("/external");
    expect(["DurableObject", "DurableObjectBase"]).toContain(
      result["(EXTERNAL) (cloudflare:workers) DurableObject.name"],
    );
  });
});
