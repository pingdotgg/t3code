import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ProviderCompatibility from "./ProviderCompatibility.ts";
import { makeProviderMaintenanceCapabilities } from "./providerMaintenance.ts";

const codexDriver = ProviderDriverKind.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const opencodeDriver = ProviderDriverKind.make("opencode");
const cursorDriver = ProviderDriverKind.make("cursor");

const baseProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: codexDriver,
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "0.130.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const codexNpmUpdateCapabilities = makeProviderMaintenanceCapabilities({
  provider: codexDriver,
  packageName: "@openai/codex",
  updateExecutable: "npm",
  updateArgs: ["install", "-g", "@openai/codex@latest"],
  updateLockKey: "npm-global",
});

function jsonHttpClient(
  responseForUrl: (url: string) => { readonly payload: unknown; readonly status?: number },
): HttpClient.HttpClient {
  return HttpClient.make((request) => {
    const response = responseForUrl(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(response.payload), {
          status: response.status ?? 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
}

const provideCompatibility = (
  responseForUrl: (url: string) => { readonly payload: unknown; readonly status?: number },
) =>
  Effect.provide(
    ProviderCompatibility.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, jsonHttpClient(responseForUrl))),
    ),
  );

describe("provider compatibility", () => {
  it("selects policies by T3 Code version range", () => {
    const document: ProviderCompatibility.ProviderCompatibilityDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: "<0.1.0",
          driver: codexDriver,
          recommendedRange: "<0.130.0",
          recommendedVersion: "0.129.0",
          ranges: [{ status: "broken", range: ">=0.130.0" }],
        },
        {
          t3CodeRange: ">=0.1.0",
          driver: codexDriver,
          recommendedRange: ">=0.130.0",
          recommendedVersion: "0.130.0",
          ranges: [{ status: "supported", range: ">=0.130.0" }],
        },
      ],
    };

    expect(
      ProviderCompatibility.createProviderCompatibilityAdvisory({
        driver: codexDriver,
        currentVersion: "0.130.0",
        document,
        t3CodeVersion: "0.0.22",
      }),
    ).toMatchObject({
      status: "broken",
      recommendedVersion: "0.129.0",
    });
  });

  it("adds a targeted compatibility update command when a recommended version is available", () => {
    const document: ProviderCompatibility.ProviderCompatibilityDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: ">=0.0.0",
          driver: codexDriver,
          recommendedRange: ">=0.129.0",
          recommendedVersion: "0.129.0",
          ranges: [{ status: "broken", range: "<0.129.0" }],
        },
      ],
    };

    expect(
      ProviderCompatibility.createProviderCompatibilityAdvisory({
        driver: codexDriver,
        currentVersion: "0.128.0",
        document,
        maintenanceCapabilities: codexNpmUpdateCapabilities,
      }),
    ).toMatchObject({
      status: "broken",
      canUpdate: true,
      updateCommand: "npm install -g @openai/codex@0.129.0",
    });
  });

  it("does not warn on disabled providers before their version has been probed", () => {
    const enriched = ProviderCompatibility.applyBundledProviderCompatibilityAdvisory({
      snapshot: {
        ...baseProvider,
        driver: cursorDriver,
        enabled: false,
        version: null,
        status: "disabled",
      },
      driver: cursorDriver,
      currentVersion: null,
    });

    expect(enriched.compatibilityAdvisory).toBeUndefined();
    expect(enriched.status).toBe("disabled");
  });

  it("classifies the bundled compatibility policies for current T3 Code builds", () => {
    const document: ProviderCompatibility.ProviderCompatibilityDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: ">=0.0.0",
          driver: codexDriver,
          recommendedRange: ">=0.129.0",
          recommendedVersion: "0.129.0",
          ranges: [
            { status: "supported", range: ">=0.129.0" },
            { status: "broken", range: "<0.129.0" },
          ],
        },
        {
          t3CodeRange: ">=0.0.0",
          driver: claudeDriver,
          recommendedRange: ">=0.2.111",
          recommendedVersion: "0.2.111",
          ranges: [{ status: "supported", range: ">=0.2.111" }],
        },
        {
          t3CodeRange: ">=0.0.0",
          driver: opencodeDriver,
          recommendedRange: ">=1.14.19",
          recommendedVersion: "1.14.19",
          ranges: [
            { status: "supported", range: ">=1.14.19" },
            { status: "broken", range: "<1.14.19" },
          ],
        },
        {
          t3CodeRange: ">=0.0.0",
          driver: cursorDriver,
          recommendedRange: ">=2026.05.09",
          recommendedVersion: "2026.05.09",
          ranges: [
            { status: "supported", range: ">=2026.05.09" },
            { status: "unknown", range: "<2026.05.09" },
          ],
        },
      ],
    };

    const classify = (driver: ProviderDriverKind, currentVersion: string) =>
      ProviderCompatibility.createProviderCompatibilityAdvisory({
        driver,
        currentVersion,
        document,
        t3CodeVersion: "0.0.22",
      })?.status;

    expect(classify(codexDriver, "0.129.0")).toBe("supported");
    expect(classify(codexDriver, "0.128.0")).toBe("broken");
    expect(classify(claudeDriver, "0.2.111")).toBe("supported");
    expect(classify(opencodeDriver, "1.14.19")).toBe("supported");
    expect(classify(opencodeDriver, "1.14.18")).toBe("broken");
    expect(classify(cursorDriver, "2026.05.09")).toBe("supported");
    expect(classify(cursorDriver, "2026.05.09-0afadcc")).toBe("supported");
    expect(classify(cursorDriver, "2026.05.08")).toBe("unknown");
  });

  it("marks OpenCode versions above the recommended compatibility cap as broken", () => {
    const classify = (currentVersion: string) =>
      ProviderCompatibility.createProviderCompatibilityAdvisory({
        driver: opencodeDriver,
        currentVersion,
      })?.status;

    expect(classify("1.14.40")).toBe("supported");
    expect(classify("1.14.41")).toBe("broken");
  });

  it("matches T3 Code nightly versions against their base release policy", () => {
    const document: ProviderCompatibility.ProviderCompatibilityDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: ">=0.0.24",
          driver: codexDriver,
          recommendedRange: ">=0.129.0",
          recommendedVersion: "0.129.0",
          ranges: [{ status: "supported", range: ">=0.129.0" }],
        },
      ],
    };

    expect(
      ProviderCompatibility.createProviderCompatibilityAdvisory({
        driver: codexDriver,
        currentVersion: "0.129.0",
        document,
        t3CodeVersion: "0.0.24-nightly.20260513.1",
      })?.status,
    ).toBe("supported");
  });

  it.effect("enriches snapshots from the remote compatibility map when available", () => {
    const remoteDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: ">=0.0.0",
          driver: "codex",
          recommendedRange: "<0.130.0",
          recommendedVersion: "0.129.0",
          ranges: [{ status: "broken", range: ">=0.130.0" }],
        },
      ],
    };

    return Effect.gen(function* () {
      const enriched =
        yield* ProviderCompatibility.enrichProviderSnapshotWithTargetedCompatibilityAdvisory(
          baseProvider,
          codexNpmUpdateCapabilities,
        ).pipe(provideCompatibility(() => ({ payload: remoteDocument })));

      expect(enriched.status).toBe("error");
      expect(enriched.compatibilityAdvisory).toMatchObject({
        status: "broken",
        recommendedVersion: "0.129.0",
        canUpdate: true,
        updateCommand: "npm install -g @openai/codex@0.129.0",
      });
    });
  });

  it.effect("caches remote compatibility documents within the service layer", () => {
    const remoteDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: ">=0.0.0",
          driver: "codex",
          recommendedRange: "<0.130.0",
          recommendedVersion: "0.129.0",
          ranges: [{ status: "broken", range: ">=0.130.0" }],
        },
      ],
    };
    const requestedUrls: string[] = [];

    return Effect.gen(function* () {
      yield* ProviderCompatibility.enrichProviderSnapshotWithCompatibilityAdvisory(baseProvider);
      yield* ProviderCompatibility.enrichProviderSnapshotWithCompatibilityAdvisory(baseProvider);

      expect(requestedUrls).toEqual([ProviderCompatibility.DEFAULT_PROVIDER_COMPATIBILITY_MAP_URL]);
    }).pipe(
      provideCompatibility((url) => {
        requestedUrls.push(url);
        return { payload: remoteDocument };
      }),
    );
  });

  it.effect("does not cache failed remote compatibility fetches", () => {
    const remoteDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: ">=0.0.0",
          driver: "codex",
          recommendedRange: "<0.130.0",
          recommendedVersion: "0.129.0",
          ranges: [{ status: "broken", range: ">=0.130.0" }],
        },
      ],
    };
    const requestedUrls: string[] = [];
    let attempt = 0;

    return Effect.gen(function* () {
      yield* ProviderCompatibility.enrichProviderSnapshotWithCompatibilityAdvisory(baseProvider);
      const enriched =
        yield* ProviderCompatibility.enrichProviderSnapshotWithCompatibilityAdvisory(baseProvider);

      expect(requestedUrls).toEqual([
        ProviderCompatibility.DEFAULT_PROVIDER_COMPATIBILITY_MAP_URL,
        ProviderCompatibility.GITHUB_PROVIDER_COMPATIBILITY_MAP_URL,
        ProviderCompatibility.DEFAULT_PROVIDER_COMPATIBILITY_MAP_URL,
      ]);
      expect(enriched.compatibilityAdvisory).toMatchObject({ status: "broken" });
    }).pipe(
      provideCompatibility((url) => {
        requestedUrls.push(url);
        attempt += 1;
        return attempt === 3 ? { payload: remoteDocument } : { payload: {}, status: 404 };
      }),
    );
  });

  it.effect("falls back from the hosted map to the GitHub raw mirror", () => {
    const remoteDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: ">=0.0.0",
          driver: "codex",
          recommendedRange: "<0.130.0",
          recommendedVersion: "0.129.0",
          ranges: [{ status: "broken", range: ">=0.130.0" }],
        },
      ],
    };
    const requestedUrls: string[] = [];

    return Effect.gen(function* () {
      const enriched = yield* ProviderCompatibility.enrichProviderSnapshotWithCompatibilityAdvisory(
        baseProvider,
      ).pipe(
        provideCompatibility((url) => {
          requestedUrls.push(url);
          return url === ProviderCompatibility.GITHUB_PROVIDER_COMPATIBILITY_MAP_URL
            ? { payload: remoteDocument }
            : { payload: {}, status: 404 };
        }),
      );

      expect(requestedUrls).toEqual([
        ProviderCompatibility.DEFAULT_PROVIDER_COMPATIBILITY_MAP_URL,
        ProviderCompatibility.GITHUB_PROVIDER_COMPATIBILITY_MAP_URL,
      ]);
      expect(enriched.compatibilityAdvisory).toMatchObject({ status: "broken" });
    });
  });

  it.effect("falls back to default remote URLs when the env override parses empty", () => {
    const remoteDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: ">=0.0.0",
          driver: "codex",
          recommendedRange: "<0.130.0",
          recommendedVersion: "0.129.0",
          ranges: [{ status: "broken", range: ">=0.130.0" }],
        },
      ],
    };
    const requestedUrls: string[] = [];

    return Effect.gen(function* () {
      const previousOverride = process.env.T3_PROVIDER_COMPATIBILITY_MAP_URL;
      process.env.T3_PROVIDER_COMPATIBILITY_MAP_URL = "  ,  ";
      const enriched = yield* ProviderCompatibility.enrichProviderSnapshotWithCompatibilityAdvisory(
        baseProvider,
      ).pipe(
        provideCompatibility((url) => {
          requestedUrls.push(url);
          return url === ProviderCompatibility.DEFAULT_PROVIDER_COMPATIBILITY_MAP_URL
            ? { payload: remoteDocument }
            : { payload: {}, status: 404 };
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousOverride === undefined) {
              delete process.env.T3_PROVIDER_COMPATIBILITY_MAP_URL;
            } else {
              process.env.T3_PROVIDER_COMPATIBILITY_MAP_URL = previousOverride;
            }
          }),
        ),
      );

      expect(requestedUrls).toEqual([ProviderCompatibility.DEFAULT_PROVIDER_COMPATIBILITY_MAP_URL]);
      expect(enriched.compatibilityAdvisory).toMatchObject({ status: "broken" });
    });
  });

  it.effect("lets the remote map relax a bundled compatibility error", () => {
    const bundledMessage =
      "This provider harness version 0.130.0 is known to be incompatible with this T3 Code release. Use 0.129.0.";
    const remoteDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: ">=0.0.0",
          driver: "codex",
          recommendedRange: ">=0.130.0",
          recommendedVersion: "0.130.0",
          ranges: [{ status: "supported", range: ">=0.130.0" }],
        },
      ],
    };

    return Effect.gen(function* () {
      const enriched = yield* ProviderCompatibility.enrichProviderSnapshotWithCompatibilityAdvisory(
        {
          ...baseProvider,
          status: "error",
          message: bundledMessage,
          compatibilityAdvisory: {
            status: "broken",
            severity: "error",
            currentVersion: "0.130.0",
            message: bundledMessage,
            recommendedRange: "<0.130.0",
            recommendedVersion: "0.129.0",
            ranges: [{ status: "broken", range: ">=0.130.0" }],
          },
        },
      ).pipe(provideCompatibility(() => ({ payload: remoteDocument })));

      expect(enriched.status).toBe("ready");
      expect(enriched.message).toBeUndefined();
      expect(enriched.compatibilityAdvisory).toMatchObject({ status: "supported" });
    });
  });

  it.effect("preserves genuine probe errors when the remote map relaxes a bundled advisory", () => {
    const bundledMessage =
      "This provider harness version 0.130.0 is known to be incompatible with this T3 Code release. Use 0.129.0.";
    const probeErrorMessage = "CLI health-check failed: process exited with code 1";
    const remoteDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: ">=0.0.0",
          driver: "codex",
          recommendedRange: ">=0.130.0",
          recommendedVersion: "0.130.0",
          ranges: [{ status: "supported", range: ">=0.130.0" }],
        },
      ],
    };

    return Effect.gen(function* () {
      const enriched = yield* ProviderCompatibility.enrichProviderSnapshotWithCompatibilityAdvisory(
        {
          ...baseProvider,
          status: "error",
          message: bundledMessage,
          compatibilityAdvisory: {
            status: "broken",
            severity: "error",
            currentVersion: "0.130.0",
            message: bundledMessage,
            recommendedRange: "<0.130.0",
            recommendedVersion: "0.129.0",
            ranges: [{ status: "broken", range: ">=0.130.0" }],
            preAdvisoryStatus: "error",
            preAdvisoryMessage: probeErrorMessage,
          },
        },
      ).pipe(provideCompatibility(() => ({ payload: remoteDocument })));

      expect(enriched.status).toBe("error");
      expect(enriched.message).toBe(probeErrorMessage);
      expect(enriched.compatibilityAdvisory).toMatchObject({ status: "supported" });
    });
  });

  it.effect("keeps probe error messages when warning advisories do not change status", () => {
    const probeErrorMessage = "Authentication failed";
    const remoteDocument = {
      version: 1,
      policies: [
        {
          t3CodeRange: ">=0.0.0",
          driver: "codex",
          recommendedRange: ">=0.130.0",
          recommendedVersion: "0.130.0",
          ranges: [{ status: "graceful", range: ">=0.130.0" }],
        },
      ],
    };

    return Effect.gen(function* () {
      const enriched = yield* ProviderCompatibility.enrichProviderSnapshotWithCompatibilityAdvisory(
        {
          ...baseProvider,
          status: "error",
          message: probeErrorMessage,
        },
      ).pipe(provideCompatibility(() => ({ payload: remoteDocument })));

      expect(enriched.status).toBe("error");
      expect(enriched.message).toBe(probeErrorMessage);
      expect(enriched.compatibilityAdvisory).toMatchObject({ status: "graceful" });
    });
  });

  it.effect("falls back to the bundled map when the remote compatibility fetch fails", () =>
    Effect.gen(function* () {
      const enriched = yield* ProviderCompatibility.enrichProviderSnapshotWithCompatibilityAdvisory(
        {
          ...baseProvider,
          version: "0.128.0",
        },
      ).pipe(provideCompatibility(() => ({ payload: {}, status: 404 })));

      expect(enriched.status).toBe("error");
      expect(enriched.compatibilityAdvisory).toMatchObject({ status: "broken" });
    }),
  );
});
