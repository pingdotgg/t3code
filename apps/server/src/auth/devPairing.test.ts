import type { ServerAuthDescriptor } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { isDevPairingEligible, validateDevPairingRequestHeaders } from "./devPairing.ts";

const descriptorWithPolicy = (policy: ServerAuthDescriptor["policy"]): ServerAuthDescriptor => ({
  policy,
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
  sessionCookieName: "t3_session",
});

const devUrl = new URL("http://localhost:5733");

describe("isDevPairingEligible", () => {
  it("is eligible only for loopback web-dev servers", () => {
    assert.isTrue(
      isDevPairingEligible({ mode: "web", devUrl }, descriptorWithPolicy("loopback-browser")),
    );
  });

  it("rejects production configurations (no devUrl)", () => {
    assert.isFalse(
      isDevPairingEligible(
        { mode: "web", devUrl: undefined },
        descriptorWithPolicy("loopback-browser"),
      ),
    );
  });

  it("rejects desktop mode even with a loopback devUrl", () => {
    assert.isFalse(
      isDevPairingEligible(
        { mode: "desktop", devUrl },
        descriptorWithPolicy("desktop-managed-local"),
      ),
    );
    assert.isFalse(
      isDevPairingEligible({ mode: "desktop", devUrl }, descriptorWithPolicy("loopback-browser")),
    );
  });

  it("rejects remote-reachable policies", () => {
    assert.isFalse(
      isDevPairingEligible({ mode: "web", devUrl }, descriptorWithPolicy("remote-reachable")),
    );
  });

  it("rejects non-loopback dev URLs so --dev-url cannot become an auth root", () => {
    assert.isFalse(
      isDevPairingEligible(
        { mode: "web", devUrl: new URL("https://some-site.example") },
        descriptorWithPolicy("loopback-browser"),
      ),
    );
    assert.isFalse(
      isDevPairingEligible(
        { mode: "web", devUrl: new URL("http://192.168.1.20:5733") },
        descriptorWithPolicy("loopback-browser"),
      ),
    );
  });

  it("accepts loopback dev URL variants", () => {
    for (const url of ["http://127.0.0.1:5733", "http://[::1]:5733"]) {
      assert.isTrue(
        isDevPairingEligible(
          { mode: "web", devUrl: new URL(url) },
          descriptorWithPolicy("loopback-browser"),
        ),
        url,
      );
    }
  });
});

describe("validateDevPairingRequestHeaders", () => {
  it("accepts an exact dev-origin Origin with a loopback Host", () => {
    assert.equal(
      validateDevPairingRequestHeaders({
        originHeader: "http://localhost:5733",
        hostHeader: "localhost:13773",
        devUrl,
      }),
      null,
    );
  });

  it("rejects missing, null, or foreign Origins", () => {
    for (const originHeader of [undefined, "", "null", "https://evil.example"]) {
      assert.equal(
        validateDevPairingRequestHeaders({
          originHeader,
          hostHeader: "localhost:13773",
          devUrl,
        }),
        "origin_mismatch",
        String(originHeader),
      );
    }
  });

  it("rejects Origins that differ from the dev origin only by port or scheme", () => {
    for (const originHeader of [
      "http://localhost:5734",
      "https://localhost:5733",
      "http://127.0.0.1:5733",
    ]) {
      assert.equal(
        validateDevPairingRequestHeaders({
          originHeader,
          hostHeader: "localhost:13773",
          devUrl,
        }),
        "origin_mismatch",
        originHeader,
      );
    }
  });

  it("rejects non-loopback Hosts (DNS rebinding) even with a matching Origin", () => {
    assert.equal(
      validateDevPairingRequestHeaders({
        originHeader: "http://localhost:5733",
        hostHeader: "evil.example:13773",
        devUrl,
      }),
      "host_not_loopback",
    );
    assert.equal(
      validateDevPairingRequestHeaders({
        originHeader: "http://localhost:5733",
        hostHeader: undefined,
        devUrl,
      }),
      "host_not_loopback",
    );
  });
});
