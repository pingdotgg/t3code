import {
  encodeDurableObjectTags,
  getDurableObjectTagMap,
  normalizeStateDomains,
  resolveWorkerDomain,
  resolveWorkerDomainZone,
  resolveWorkersDev,
  shouldRecreateWorkerDomainAttachment,
  shouldObserveWorkerCrons,
  shouldObserveWorkerDomains,
  shouldObserveWorkerRoutes,
  stateCustomDomains,
  stateWorkerDomain,
} from "@/Cloudflare/Workers/WorkerProvider";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

describe("WorkerProvider", () => {
  describe("normalizeStateDomains", () => {
    // Worker state has gone through three generations: <= beta.44 stored each
    // custom domain as a `{ id, hostname, zoneId }` object; beta.45 – beta.57
    // stored `https://<hostname>` URL strings (with the workers.dev URL mixed
    // in); the current format stores bare hostnames aligned with `allUrls`.
    // The diff path reads all three without throwing (#546).
    test("coerces legacy domain objects to hostnames", () => {
      expect(
        normalizeStateDomains([
          { id: "abc", hostname: "metrics.example.com", zoneId: "z1" },
        ]),
      ).toEqual(["metrics.example.com"]);
    });

    test("coerces legacy https:// URL strings to hostnames", () => {
      expect(
        normalizeStateDomains([
          "https://app.example.com",
          "https://my-worker.acct.workers.dev",
        ]),
      ).toEqual(["app.example.com", "my-worker.acct.workers.dev"]);
    });

    test("leaves current-format hostnames untouched", () => {
      expect(normalizeStateDomains(["app.example.com", "localhost"])).toEqual([
        "app.example.com",
        "localhost",
      ]);
    });

    test("drops entries that fit no state generation", () => {
      expect(
        normalizeStateDomains([
          "https://keep.example.com",
          { id: "no-hostname" },
          { hostname: 123 },
          null,
          42,
          "",
        ]),
      ).toEqual(["keep.example.com"]);
    });

    test("returns an empty array for undefined state", () => {
      expect(normalizeStateDomains(undefined)).toEqual([]);
    });
  });

  describe("stateCustomDomains", () => {
    test("excludes workers.dev, preview, and local-dev entries", () => {
      expect(
        stateCustomDomains([
          "my-worker.acct.workers.dev",
          "0a1b2c3d-my-worker.acct.workers.dev",
          "localhost",
          "192.168.0.12",
          "app.example.com",
        ]),
      ).toEqual(["app.example.com"]);
    });

    test("reads legacy URL-string state", () => {
      expect(
        stateCustomDomains([
          "https://app.example.com",
          "https://my-worker.acct.workers.dev",
        ]),
      ).toEqual(["app.example.com"]);
    });
  });

  describe("resolveWorkerDomain", () => {
    const resolve = (domain: Parameters<typeof resolveWorkerDomain>[0]) =>
      Effect.runSync(resolveWorkerDomain(domain));

    test("string shorthand resolves to { name }", () => {
      expect(resolve("app.example.com")).toEqual({
        name: "app.example.com",
        aliases: [],
        redirects: [],
      });
    });

    test("object form dedupes and punycodes hostnames", () => {
      expect(
        resolve({
          name: "📦.example.com",
          aliases: ["www.example.com", "www.example.com"],
          redirects: ["old.example.com"],
        }),
      ).toEqual({
        name: "xn--cu8h.example.com",
        aliases: ["www.example.com"],
        redirects: ["old.example.com"],
      });
    });

    test("undefined and null resolve to no domain", () => {
      expect(resolve(undefined)).toBeUndefined();
      expect(resolve(null)).toBeUndefined();
    });

    // Pre-redesign props stored `domain: string[]` — persisted `olds` can
    // still hand that shape to read's classification. `domains[0]` was the
    // primary hostname back then, so it maps to `name`; the rest to
    // aliases. A legacy empty array was the explicit detach-all.
    test("legacy string[] maps to name + aliases", () => {
      expect(resolve(["app.example.com", "www.example.com"])).toEqual({
        name: "app.example.com",
        aliases: ["www.example.com"],
        redirects: [],
      });
      expect(resolve([])).toBeUndefined();
    });

    test("a hostname in more than one role is a typed error", () => {
      const result = Effect.runSync(
        Effect.result(
          resolveWorkerDomain({
            name: "app.example.com",
            aliases: ["app.example.com"],
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toEqual("WorkerDomainConfigError");
      }
    });

    test("carries zoneId / zone / zoneName pins", () => {
      const zoneId = "0123456789abcdef0123456789abcdef";
      expect(
        resolve({
          name: "app.example.com",
          zoneId,
        }),
      ).toEqual({
        name: "app.example.com",
        aliases: [],
        redirects: [],
        zone: zoneId,
      });
      expect(
        resolve({
          name: "app.example.com",
          zoneName: "example.com",
        }),
      ).toEqual({
        name: "app.example.com",
        aliases: [],
        redirects: [],
        zone: "example.com",
      });
      expect(
        resolveWorkerDomainZone({
          zoneId,
          zoneName: "ignored.com",
          zone: "also-ignored.com",
        }),
      ).toEqual(zoneId);
    });

    test("recreates an existing attachment only for a changed explicit zone", () => {
      expect(shouldRecreateWorkerDomainAttachment("live-zone", undefined)).toBe(
        false,
      );
      expect(
        shouldRecreateWorkerDomainAttachment("live-zone", "live-zone"),
      ).toBe(false);
      expect(
        shouldRecreateWorkerDomainAttachment("live-zone", "desired-zone"),
      ).toBe(true);
    });
  });

  describe("stateWorkerDomain", () => {
    test("passes the current-format domain attribute through", () => {
      expect(
        stateWorkerDomain({
          domain: {
            name: "app.example.com",
            aliases: ["www.example.com"],
            redirects: ["old.example.com"],
          },
        }),
      ).toEqual({
        name: "app.example.com",
        aliases: ["www.example.com"],
        redirects: ["old.example.com"],
      });
      expect(
        stateWorkerDomain({
          domain: {
            name: "app.example.com",
            aliases: [],
            redirects: [],
            zoneId: "0123456789abcdef0123456789abcdef",
          },
        }),
      ).toEqual({
        name: "app.example.com",
        aliases: [],
        redirects: [],
        zone: "0123456789abcdef0123456789abcdef",
      });
      expect(
        stateWorkerDomain({
          domain: {
            name: "app.example.com",
            aliases: [],
            redirects: [],
            zoneId: 42,
            zoneName: "example.com",
          },
        }),
      ).toEqual({
        name: "app.example.com",
        aliases: [],
        redirects: [],
        zone: "example.com",
      });
    });

    test("derives name + aliases from legacy URL-string domains state", () => {
      expect(
        stateWorkerDomain({
          domains: [
            "https://app.example.com",
            "https://www.example.com",
            "https://my-worker.acct.workers.dev",
          ],
        }),
      ).toEqual({
        name: "app.example.com",
        aliases: ["www.example.com"],
        redirects: [],
      });
    });

    test("derives from <= beta.44 domain objects", () => {
      expect(
        stateWorkerDomain({
          domains: [{ id: "abc", hostname: "app.example.com", zoneId: "z" }],
        }),
      ).toEqual({
        name: "app.example.com",
        aliases: [],
        redirects: [],
      });
    });

    test("workers.dev-only and empty state resolve to no domain", () => {
      expect(
        stateWorkerDomain({
          domains: ["https://my-worker.acct.workers.dev"],
        }),
      ).toBeUndefined();
      expect(stateWorkerDomain({})).toBeUndefined();
      expect(stateWorkerDomain(undefined)).toBeUndefined();
    });
  });

  describe("resolveWorkersDev", () => {
    test("defaults to the full workers.dev behavior", () => {
      expect(resolveWorkersDev(undefined)).toEqual({
        enabled: true,
        previewsEnabled: true,
      });
      expect(resolveWorkersDev(true)).toEqual({
        enabled: true,
        previewsEnabled: true,
      });
    });

    test("false disables both toggles", () => {
      expect(resolveWorkersDev(false)).toEqual({
        enabled: false,
        previewsEnabled: false,
      });
    });

    test("object form fills unset toggles with true", () => {
      expect(resolveWorkersDev({})).toEqual({
        enabled: true,
        previewsEnabled: true,
      });
      expect(resolveWorkersDev({ enabled: false })).toEqual({
        enabled: false,
        previewsEnabled: true,
      });
      expect(resolveWorkersDev({ previewsEnabled: false })).toEqual({
        enabled: true,
        previewsEnabled: false,
      });
      expect(
        resolveWorkersDev({ enabled: false, previewsEnabled: true }),
      ).toEqual({
        enabled: false,
        previewsEnabled: true,
      });
    });
  });

  // Cloudflare allows at most 10 tags per worker and 1024 bytes per tag, so
  // the DO logical-id→class mapping is packed into `alchemy:dos:` tags
  // instead of one `alchemy:do:` tag per binding (#811).
  describe("durable object tags", () => {
    test("packs all mappings into a single tag", () => {
      expect(
        encodeDurableObjectTags([
          { logicalId: "Counter", className: "Counter" },
          { logicalId: "Meter", className: "MeterV2" },
        ]),
      ).toEqual(["alchemy:dos:Counter;Meter=MeterV2"]);
    });

    test("elides the class name when it equals the logical id", () => {
      expect(
        encodeDurableObjectTags([{ logicalId: "A", className: "A" }]),
      ).toEqual(["alchemy:dos:A"]);
    });

    test("output is deterministic regardless of input order", () => {
      const forward = encodeDurableObjectTags([
        { logicalId: "A", className: "A1" },
        { logicalId: "B", className: "B1" },
      ]);
      const reverse = encodeDurableObjectTags([
        { logicalId: "B", className: "B1" },
        { logicalId: "A", className: "A1" },
      ]);
      expect(forward).toEqual(reverse);
    });

    test("round-trips through the parser", () => {
      const mappings = Array.from({ length: 25 }, (_, i) => ({
        logicalId: `binding-${i}`,
        className: `ClassName${i}`,
      }));
      expect(getDurableObjectTagMap(encodeDurableObjectTags(mappings))).toEqual(
        Object.fromEntries(
          mappings.map(({ logicalId, className }) => [logicalId, className]),
        ),
      );
    });

    test("escapes separators and Cloudflare-forbidden characters", () => {
      const mappings = [
        { logicalId: "a;b", className: "C1" },
        { logicalId: "a=b", className: "C2" },
        { logicalId: "a,b&c", className: "C3" },
        { logicalId: "a:b", className: "C4" },
      ];
      const tags = encodeDurableObjectTags(mappings);
      for (const tag of tags) {
        expect(tag).not.toContain(",");
        expect(tag).not.toContain("&");
      }
      expect(getDurableObjectTagMap(tags)).toEqual({
        "a;b": "C1",
        "a=b": "C2",
        "a,b&c": "C3",
        "a:b": "C4",
      });
    });

    test("splits into multiple tags at the 1024-byte limit", () => {
      const mappings = Array.from({ length: 100 }, (_, i) => ({
        logicalId: `some-durable-object-binding-${i}`,
        className: `SomeDurableObjectClassName${i}`,
      }));
      const tags = encodeDurableObjectTags(mappings);
      expect(tags.length).toBeGreaterThan(1);
      for (const tag of tags) {
        expect(tag.length).toBeLessThanOrEqual(1024);
        expect(tag.startsWith("alchemy:dos:")).toBe(true);
      }
      expect(getDurableObjectTagMap(tags)).toEqual(
        Object.fromEntries(
          mappings.map(({ logicalId, className }) => [logicalId, className]),
        ),
      );
    });

    test("unicode identifiers stay within the byte limit", () => {
      const mappings = Array.from({ length: 40 }, (_, i) => ({
        logicalId: `对象-${i}`,
        className: `Class_${i}`,
      }));
      const tags = encodeDurableObjectTags(mappings);
      const encoder = new TextEncoder();
      for (const tag of tags) {
        expect(encoder.encode(tag).length).toBeLessThanOrEqual(1024);
      }
      expect(getDurableObjectTagMap(tags)).toEqual(
        Object.fromEntries(
          mappings.map(({ logicalId, className }) => [logicalId, className]),
        ),
      );
    });

    test("parses legacy per-DO alchemy:do: tags", () => {
      expect(
        getDurableObjectTagMap([
          "alchemy:stack:app",
          "alchemy:do:Counter:CounterV2",
          "alchemy:do:Meter:Meter",
          "user-tag",
        ]),
      ).toEqual({ Counter: "CounterV2", Meter: "Meter" });
    });

    test("packed entries win over legacy entries for the same logical id", () => {
      expect(
        getDurableObjectTagMap([
          "alchemy:do:Counter:OldClass",
          "alchemy:dos:Counter=NewClass",
        ]),
      ).toEqual({ Counter: "NewClass" });
    });

    test("returns an empty map when no DO tags are present", () => {
      expect(getDurableObjectTagMap(["alchemy:stack:app", "user"])).toEqual({});
    });
  });

  // Worker read used to always fan out listDomains + account-wide route
  // discovery + getScriptSchedule, even for a plain workers.dev Worker. That
  // stampeded GET /accounts/{id}/workers/subdomain neighbors into 429/code 971
  // (#926). These helpers gate those observations on whether Alchemy manages
  // the surface.
  describe("shouldObserveWorkerDomains", () => {
    test("skips when neither props nor state manage custom domains", () => {
      expect(
        shouldObserveWorkerDomains(
          {},
          {
            domains: ["https://my-worker.acct.workers.dev"],
          },
        ),
      ).toBe(false);
      expect(shouldObserveWorkerDomains(undefined, undefined)).toBe(false);
    });

    test("observes when domain prop is present, including null", () => {
      expect(shouldObserveWorkerDomains({ domain: null }, undefined)).toBe(
        true,
      );
      expect(
        shouldObserveWorkerDomains({ domain: "app.example.com" }, undefined),
      ).toBe(true);
    });

    test("observes when prior state has non-workers.dev domains", () => {
      expect(
        shouldObserveWorkerDomains(
          {},
          {
            domains: [
              "https://app.example.com",
              "https://my-worker.acct.workers.dev",
            ],
          },
        ),
      ).toBe(true);
    });
  });

  describe("shouldObserveWorkerRoutes", () => {
    test("skips when neither props nor state manage routes", () => {
      expect(shouldObserveWorkerRoutes({}, { routes: [] })).toBe(false);
      expect(shouldObserveWorkerRoutes(undefined, undefined)).toBe(false);
    });

    test("observes when routes prop is present, including empty array", () => {
      expect(shouldObserveWorkerRoutes({ routes: [] }, undefined)).toBe(true);
      expect(
        shouldObserveWorkerRoutes(
          { routes: [{ pattern: "example.com/*" }] },
          undefined,
        ),
      ).toBe(true);
    });

    test("observes when prior state has routes", () => {
      expect(
        shouldObserveWorkerRoutes(
          {},
          {
            routes: [{ id: "r1", pattern: "example.com/*", zoneId: "z1" }],
          },
        ),
      ).toBe(true);
    });
  });

  describe("shouldObserveWorkerCrons", () => {
    test("skips when neither props nor state manage crons", () => {
      expect(shouldObserveWorkerCrons({}, { crons: [] })).toBe(false);
      expect(shouldObserveWorkerCrons(undefined, undefined)).toBe(false);
    });

    test("observes when crons prop is present, including empty array", () => {
      expect(shouldObserveWorkerCrons({ crons: [] }, undefined)).toBe(true);
      expect(
        shouldObserveWorkerCrons({ crons: ["0 * * * *"] }, undefined),
      ).toBe(true);
    });

    test("observes when prior state has crons (e.g. Effect-native cron())", () => {
      expect(shouldObserveWorkerCrons({}, { crons: ["0 * * * *"] })).toBe(true);
    });
  });
});
