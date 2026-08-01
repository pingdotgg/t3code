import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  PreviewTabId,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  LIVE_GATEWAY_BOOTSTRAP_TTL_MS,
  LIVE_GATEWAY_LEASE_TTL_MS,
  type LiveGatewayLease,
  isLiveGatewayRuntimeSupported,
  make,
  resolveLiveGatewayTarget,
} from "./LiveGateway.ts";

const threadId = ThreadId.make("thread-live-gateway");
const tabId = PreviewTabId.make("tab-live-gateway");
const sessionId = AuthSessionId.make("session-live-gateway");

function snapshot(url?: string): PreviewSessionSnapshot {
  return {
    threadId,
    tabId,
    navStatus: url === undefined ? { _tag: "Idle" } : { _tag: "Success", url, title: "Preview" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function bootstrapToken(relativeUrl: string): string {
  return relativeUrl.slice(relativeUrl.lastIndexOf("/") + 1);
}

function leaseFields(lease: LiveGatewayLease) {
  const { invalidated: _invalidated, ...fields } = lease;
  return fields;
}

it.layer(NodeServices.layer)("PreviewLiveGateway", (it) => {
  it.effect("accepts only explicit loopback HTTP targets and preserves host family", () =>
    Effect.gen(function* () {
      expect(yield* resolveLiveGatewayTarget(snapshot("http://localhost:5173/a?q=1#hash"))).toEqual(
        {
          origin: "http://localhost:5173",
          redirectPath: "/a?q=1#hash",
        },
      );
      expect(yield* resolveLiveGatewayTarget(snapshot("http://0.0.0.0:4173/"))).toEqual({
        origin: "http://127.0.0.1:4173",
        redirectPath: "/",
      });
      expect(yield* resolveLiveGatewayTarget(snapshot("http://[::1]:3000/"))).toEqual({
        origin: "http://[::1]:3000",
        redirectPath: "/",
      });

      const publicError = yield* resolveLiveGatewayTarget(snapshot("https://example.com/")).pipe(
        Effect.flip,
      );
      expect(publicError.reason).toBe("target_not_loopback");

      const credentialError = yield* resolveLiveGatewayTarget(
        snapshot("http://user:password@localhost:5173/"),
      ).pipe(Effect.flip);
      expect(credentialError.reason).toBe("target_invalid");

      const idleError = yield* resolveLiveGatewayTarget(snapshot()).pipe(Effect.flip);
      expect(idleError.reason).toBe("preview_idle");
      expect(isLiveGatewayRuntimeSupported()).toBe(true);
    }),
  );

  it.effect("uses one-use bootstraps and keeps an active lease through RPC reconnects", () =>
    Effect.gen(function* () {
      const gateway = yield* make;
      const first = yield* gateway.issue({
        sessionId,
        snapshot: snapshot("http://localhost:5173/"),
      });
      const firstConsumed = yield* gateway.consumeBootstrap(bootstrapToken(first.relativeUrl));
      expect(firstConsumed).not.toBeNull();
      if (firstConsumed === null) return;

      expect(yield* gateway.consumeBootstrap(bootstrapToken(first.relativeUrl))).toBeNull();
      expect(yield* gateway.resolveLease(firstConsumed.cookieValue)).toMatchObject(
        leaseFields(firstConsumed.lease),
      );
      const firstInvalidated = yield* firstConsumed.lease.invalidated.pipe(Effect.forkChild);

      // Issuing a replacement bootstrap is what a reconnected RPC client does.
      // It must not invalidate the WebView until the replacement is consumed.
      const replacement = yield* gateway.issue({
        sessionId,
        snapshot: snapshot("http://localhost:5173/next"),
      });
      expect(yield* gateway.resolveLease(firstConsumed.cookieValue)).toMatchObject(
        leaseFields(firstConsumed.lease),
      );
      yield* Effect.yieldNow;
      expect(firstInvalidated.pollUnsafe()).toBeUndefined();

      const replacementConsumed = yield* gateway.consumeBootstrap(
        bootstrapToken(replacement.relativeUrl),
      );
      yield* Fiber.join(firstInvalidated);
      expect(replacementConsumed).not.toBeNull();
      expect(yield* gateway.resolveLease(firstConsumed.cookieValue)).toBeNull();
      if (replacementConsumed !== null) {
        expect(yield* gateway.resolveLease(replacementConsumed.cookieValue)).toMatchObject(
          leaseFields(replacementConsumed.lease),
        );
      }
    }),
  );

  it.effect("expires bootstraps and leases and supports explicit tab/session revocation", () =>
    Effect.gen(function* () {
      const gateway = yield* make;
      const expiredBootstrap = yield* gateway.issue({
        sessionId,
        snapshot: snapshot("http://localhost:5173/"),
      });
      yield* TestClock.adjust(Duration.millis(LIVE_GATEWAY_BOOTSTRAP_TTL_MS));
      expect(
        yield* gateway.consumeBootstrap(bootstrapToken(expiredBootstrap.relativeUrl)),
      ).toBeNull();

      const issued = yield* gateway.issue({
        sessionId,
        snapshot: snapshot("http://localhost:5173/"),
      });
      const consumed = yield* gateway.consumeBootstrap(bootstrapToken(issued.relativeUrl));
      expect(consumed).not.toBeNull();
      if (consumed === null) return;

      const tabInvalidated = yield* consumed.lease.invalidated.pipe(Effect.forkChild);
      yield* gateway.revokeTab({ threadId, tabId });
      yield* Fiber.join(tabInvalidated);
      expect(yield* gateway.resolveLease(consumed.cookieValue)).toBeNull();

      const sessionIssued = yield* gateway.issue({
        sessionId,
        snapshot: snapshot("http://localhost:5173/"),
      });
      const sessionConsumed = yield* gateway.consumeBootstrap(
        bootstrapToken(sessionIssued.relativeUrl),
      );
      expect(sessionConsumed).not.toBeNull();
      if (sessionConsumed === null) return;
      const sessionInvalidated = yield* sessionConsumed.lease.invalidated.pipe(Effect.forkChild);
      yield* gateway.revokeSession(sessionId);
      yield* Fiber.join(sessionInvalidated);
      expect(yield* gateway.resolveLease(sessionConsumed.cookieValue)).toBeNull();

      const ttlIssued = yield* gateway.issue({
        sessionId,
        snapshot: snapshot("http://localhost:5173/"),
      });
      const ttlConsumed = yield* gateway.consumeBootstrap(bootstrapToken(ttlIssued.relativeUrl));
      expect(ttlConsumed).not.toBeNull();
      if (ttlConsumed === null) return;
      const ttlInvalidated = yield* ttlConsumed.lease.invalidated.pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(LIVE_GATEWAY_LEASE_TTL_MS));
      yield* Fiber.join(ttlInvalidated);
      expect(yield* gateway.resolveLease(ttlConsumed.cookieValue)).toBeNull();
    }),
  );

  it.effect("caps bootstraps and active leases at the parent authentication expiry", () =>
    Effect.gen(function* () {
      const gateway = yield* make;
      const now = yield* Clock.currentTimeMillis;
      const sessionExpiresAt = now + 1_000;
      const issued = yield* gateway.issue({
        sessionId,
        sessionExpiresAt,
        snapshot: snapshot("http://localhost:5173/"),
      });
      expect(issued.expiresAt).toBe(sessionExpiresAt);

      const consumed = yield* gateway.consumeBootstrap(bootstrapToken(issued.relativeUrl));
      expect(consumed).not.toBeNull();
      if (consumed === null) return;
      expect(consumed.lease.expiresAt).toBe(sessionExpiresAt);

      const invalidated = yield* consumed.lease.invalidated.pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(invalidated);
      expect(yield* gateway.resolveLease(consumed.cookieValue)).toBeNull();

      const expired = yield* gateway
        .issue({
          sessionId,
          sessionExpiresAt,
          snapshot: snapshot("http://localhost:5173/"),
        })
        .pipe(Effect.flip);
      expect(expired.reason).toBe("session_expired");
    }),
  );

  it.effect("keeps an active lease alive for the authenticated session", () =>
    Effect.gen(function* () {
      const gateway = yield* make;
      const now = yield* Clock.currentTimeMillis;
      const sessionExpiresAt = now + LIVE_GATEWAY_LEASE_TTL_MS * 4;
      const issued = yield* gateway.issue({
        sessionId,
        sessionExpiresAt,
        snapshot: snapshot("http://localhost:5173/"),
      });

      const consumed = yield* gateway.consumeBootstrap(bootstrapToken(issued.relativeUrl));
      expect(consumed).not.toBeNull();
      if (consumed === null) return;
      expect(consumed.lease.expiresAt).toBe(sessionExpiresAt);

      const invalidated = yield* consumed.lease.invalidated.pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(LIVE_GATEWAY_LEASE_TTL_MS));
      expect(invalidated.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(Duration.millis(LIVE_GATEWAY_LEASE_TTL_MS * 3));
      yield* Fiber.join(invalidated);
      expect(yield* gateway.resolveLease(consumed.cookieValue)).toBeNull();
    }),
  );
});
