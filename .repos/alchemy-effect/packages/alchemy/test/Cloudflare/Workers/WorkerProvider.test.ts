import {
  encodeDurableObjectTags,
  getDurableObjectTagMap,
  normalizeStateDomains,
} from "@/Cloudflare/Workers/WorkerProvider";
import { describe, expect, test } from "alchemy-test";

describe("WorkerProvider", () => {
  describe("normalizeStateDomains", () => {
    // Worker state written by Alchemy <= beta.44 stored each custom domain as a
    // `{ id, hostname, zoneId }` object; beta.45+ stores `https://<hostname>`
    // strings. The diff path then called `.endsWith` directly on each entry and
    // threw `u.endsWith is not a function` when reading the older object state
    // (#546).
    test("coerces legacy domain objects to https:// strings", () => {
      expect(
        normalizeStateDomains([
          { id: "abc", hostname: "metrics.example.com", zoneId: "z1" },
        ]),
      ).toEqual(["https://metrics.example.com"]);
    });

    test("leaves modern string entries untouched", () => {
      expect(
        normalizeStateDomains([
          "https://app.example.com",
          "https://my-worker.acct.workers.dev",
        ]),
      ).toEqual([
        "https://app.example.com",
        "https://my-worker.acct.workers.dev",
      ]);
    });

    test("keeps the diff filter and workers.dev lookup working after normalization", () => {
      const normalized = normalizeStateDomains([
        { id: "abc", hostname: "app.example.com", zoneId: "z1" },
        "https://my-worker.acct.workers.dev",
      ]);
      // custom domains used by the domainsChanged diff (workers.dev excluded)
      expect(normalized.filter((u) => !u.endsWith(".workers.dev"))).toEqual([
        "https://app.example.com",
      ]);
      // the workers.dev url stays findable for the `newUrl` computation
      expect(normalized.find((u) => u.endsWith(".workers.dev"))).toBe(
        "https://my-worker.acct.workers.dev",
      );
    });

    test("drops entries that are neither strings nor objects with a string hostname", () => {
      expect(
        normalizeStateDomains([
          "https://keep.example.com",
          { id: "no-hostname" },
          { hostname: 123 },
          null,
          42,
        ]),
      ).toEqual(["https://keep.example.com"]);
    });

    test("returns an empty array for undefined state", () => {
      expect(normalizeStateDomains(undefined)).toEqual([]);
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
});
