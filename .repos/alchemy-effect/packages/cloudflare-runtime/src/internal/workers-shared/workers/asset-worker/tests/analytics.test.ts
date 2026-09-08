// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { describe, it, vi } from "vitest";
import { Analytics, EntrypointType } from "../src/analytics.ts";
import type { ReadyAnalyticsEvent } from "../src/types.ts";

describe("[Asset Worker] Analytics", () => {
  function captureEvent(): {
    analytics: Analytics;
    getEvent: () => ReadyAnalyticsEvent | undefined;
  } {
    let captured: ReadyAnalyticsEvent | undefined;
    const mockReadyAnalytics = {
      logEvent: vi.fn((event: ReadyAnalyticsEvent) => {
        captured = event;
      }),
    };
    return {
      analytics: new Analytics(mockReadyAnalytics),
      getEvent: () => captured,
    };
  }

  describe("EntrypointType enum", () => {
    it("has expected numeric values", ({ expect }) => {
      expect(EntrypointType.Outer).toBe(0);
      expect(EntrypointType.Inner).toBe(1);
    });
  });

  describe("entrypoint discriminator (double7)", () => {
    it("writes -1 when entrypoint is not set", ({ expect }) => {
      const { analytics, getEvent } = captureEvent();
      analytics.write();

      const event = getEvent();
      expect(event?.doubles?.[6]).toBe(-1);
    });
  });

  describe("full event shape", () => {
    it("preserves all existing fields alongside new ones", ({ expect }) => {
      const { analytics, getEvent } = captureEvent();
      analytics.setData({
        accountId: 123,
        scriptId: 456,
        requestTime: 50,
        coloId: 1,
        metalId: 2,
        coloTier: 3,
        status: 200,
        entrypoint: EntrypointType.Inner,
        hostname: "example.com",
        userAgent: "test-agent",
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "none",
        error: "",
        version: "abc123",
        coloRegion: "WEUR",
        cacheStatus: "HIT",
        cohort: "free",
      });
      analytics.write();

      const event = getEvent();
      // Doubles
      expect(event?.doubles?.[0]).toBe(50); // requestTime
      expect(event?.doubles?.[1]).toBe(1); // coloId
      expect(event?.doubles?.[2]).toBe(2); // metalId
      expect(event?.doubles?.[3]).toBe(3); // coloTier
      expect(event?.doubles?.[4]).toBe(200); // status
      // double6 is compatibilityFlags bitmask, defaults to 0
      expect(event?.doubles?.[5]).toBe(0);
      expect(event?.doubles?.[6]).toBe(EntrypointType.Inner); // entrypoint

      // Blobs
      expect(event?.blobs?.[0]).toBe("example.com"); // hostname
      expect(event?.blobs?.[1]).toBe("test-agent"); // userAgent
      expect(event?.blobs?.[2]).toBe("auto-trailing-slash"); // htmlHandling
      expect(event?.blobs?.[3]).toBe("none"); // notFoundHandling
      expect(event?.blobs?.[4]).toBe(""); // error
      expect(event?.blobs?.[5]).toBe("abc123"); // version
      expect(event?.blobs?.[6]).toBe("WEUR"); // coloRegion
      expect(event?.blobs?.[7]).toBe("HIT"); // cacheStatus
      expect(event?.blobs?.[8]).toBe("free"); // cohort

      // Indexes
      expect(event?.accountId).toBe(123);
      expect(event?.indexId).toBe("456");
    });
  });
});
