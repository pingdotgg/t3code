import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const NOW = Date.parse("2026-10-10T00:00:00.000Z");
const IN_ONE_HOUR = "2026-10-10T01:00:00.000Z";
const IN_TWO_HOURS = "2026-10-10T02:00:00.000Z";
const IN_ONE_DAY = "2026-10-11T00:00:00.000Z";

const window = (
  id: "five_hour" | "seven_day",
  usedPercent: number,
  resetsAt?: string,
): ServerProviderUsageWindow => ({
  id,
  kind: id === "five_hour" ? "session" : "weekly",
  label: id,
  usedPercent,
  ...(resetsAt ? { resetsAt } : {}),
});

const account = (
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  driver = "claudeAgent",
): UsageLimitSourceAccount => ({
  id: "account.json",
  driver: ProviderDriverKind.make(driver),
  usageLimits: { checkedAt: "2026-10-09T23:59:00.000Z", windows },
});

describe("poolUsageLimitResetAt", () => {
  it("is the reset of the only exhausted window", () => {
    expect(
      UsageLimitSources.poolUsageLimitResetAt(
        [account([window("five_hour", 100, IN_TWO_HOURS), window("seven_day", 40, IN_ONE_DAY)])],
        NOW,
      ),
    ).toBe(IN_TWO_HOURS);
  });

  it("waits for every exhausted window of an account", () => {
    expect(
      UsageLimitSources.poolUsageLimitResetAt(
        [account([window("five_hour", 100, IN_TWO_HOURS), window("seven_day", 100, IN_ONE_DAY)])],
        NOW,
      ),
    ).toBe(IN_ONE_DAY);
  });

  it("resumes when the first account recovers", () => {
    expect(
      UsageLimitSources.poolUsageLimitResetAt(
        [
          account([window("five_hour", 100, IN_TWO_HOURS)]),
          account([window("five_hour", 100, IN_ONE_HOUR), window("seven_day", 100, IN_ONE_DAY)]),
          account([window("five_hour", 100, IN_ONE_DAY)]),
        ],
        NOW,
      ),
    ).toBe(IN_TWO_HOURS);
  });

  it("is unknown while any account still has headroom", () => {
    expect(
      UsageLimitSources.poolUsageLimitResetAt(
        [account([window("five_hour", 100, IN_ONE_HOUR)]), account([window("five_hour", 60)])],
        NOW,
      ),
    ).toBeNull();
  });

  it("is unknown when an exhausted window has no reset time", () => {
    expect(
      UsageLimitSources.poolUsageLimitResetAt(
        [account([window("five_hour", 100, IN_ONE_HOUR), window("seven_day", 100)])],
        NOW,
      ),
    ).toBeNull();
  });

  it("is unknown when the reset has already passed", () => {
    expect(
      UsageLimitSources.poolUsageLimitResetAt(
        [account([window("five_hour", 100, "2026-10-09T23:00:00.000Z")])],
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores accounts that are not Claude", () => {
    const codexOnly = [account([window("five_hour", 100, IN_ONE_HOUR)], "codex")];
    expect(UsageLimitSources.poolUsageLimitResetAt(codexOnly, NOW)).toBeNull();
    expect(
      UsageLimitSources.poolUsageLimitResetAt(
        [...codexOnly, account([window("five_hour", 100, IN_TWO_HOURS)])],
        NOW,
      ),
    ).toBe(IN_TWO_HOURS);
  });
});

const hubs = {
  "exhausted.test:8317": [
    { id: "a.json", five: 100, reset: IN_TWO_HOURS },
    { id: "b.json", five: 100, reset: IN_ONE_HOUR },
  ],
  "headroom.test:8317": [
    { id: "a.json", five: 100, reset: IN_ONE_HOUR },
    { id: "b.json", five: 20, reset: IN_ONE_DAY },
  ],
} as const;

function fixture(
  sources: Record<string, { url: string; managementKey: string; enabled: boolean }>,
) {
  const authFileReads: Array<string> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const accounts = hubs[url.host as keyof typeof hubs] ?? [];
      if (url.pathname.endsWith("/auth-files")) {
        authFileReads.push(url.host);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            files: accounts.map((entry) => ({
              id: entry.id,
              auth_index: entry.id,
              provider: "claude",
            })),
          }),
        );
      }
      const body: { auth_index: string } =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : { auth_index: "" };
      const entry = accounts.find((candidate) => candidate.id === body.auth_index);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          status_code: 200,
          body: JSON.stringify({
            five_hour: { utilization: entry?.five ?? 0, resets_at: entry?.reset ?? null },
          }),
        }),
      );
    }),
  );
  const layer = UsageLimitSources.layer.pipe(
    Layer.provide(
      ServerSettings.layerTest({
        usageLimitSources: Object.fromEntries(
          Object.entries(sources).map(([id, source]) => [id, { kind: "cliproxy", ...source }]),
        ),
      }),
    ),
    Layer.provide(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(NodeCrypto.layer),
  );
  return { authFileReads, layer };
}

const source = (host: string, overrides: { managementKey?: string; enabled?: boolean } = {}) => ({
  url: `http://${host}`,
  managementKey: "management-secret",
  enabled: true,
  ...overrides,
});

describe("UsageLimitSources.poolResetAt", () => {
  it.effect("matches the hub by origin and re-reads it once", () => {
    const test = fixture({ hub: source("exhausted.test:8317/") });
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.UsageLimitSources;
      // Settle the read the service starts on construction.
      yield* sources.refresh;
      const before = test.authFileReads.length;
      expect(yield* sources.poolResetAt("http://exhausted.test:8317")).toBe(IN_ONE_HOUR);
      expect(test.authFileReads.length - before).toBe(1);
      expect(yield* sources.poolResetAt("http://exhausted.test:8317/v1/")).toBe(IN_ONE_HOUR);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("ignores other hosts, invalid URLs, and disabled sources without reading", () => {
    const test = fixture({
      enabled: source("exhausted.test:8317", { enabled: false }),
      other: source("headroom.test:8317"),
    });
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.UsageLimitSources;
      yield* sources.refresh;
      const before = test.authFileReads.length;
      expect(yield* sources.poolResetAt("http://exhausted.test:8317")).toBeNull();
      expect(yield* sources.poolResetAt("http://exhausted.test:9999")).toBeNull();
      expect(yield* sources.poolResetAt("not a url")).toBeNull();
      expect(test.authFileReads.length).toBe(before);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("is unknown while a pooled account has headroom", () => {
    const test = fixture({ hub: source("headroom.test:8317") });
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.UsageLimitSources;
      expect(yield* sources.poolResetAt("http://headroom.test:8317")).toBeNull();
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("skips a matching source that failed to read", () => {
    const test = fixture({
      broken: source("exhausted.test:8317", { managementKey: "" }),
      working: source("exhausted.test:8317"),
    });
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.UsageLimitSources;
      expect(yield* sources.poolResetAt("http://exhausted.test:8317")).toBe(IN_ONE_HOUR);
    }).pipe(Effect.provide(test.layer));
  });
});
