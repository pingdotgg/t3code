import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, PeerLinkError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PeerEnvironmentRegistryError } from "./PeerEnvironmentRegistry.ts";
import { resolvePeerSession } from "./PeerSessionResolve.ts";

const environmentId = EnvironmentId.make("environment:worker");

const linkError = (reason: "unknown_link" | "expired") =>
  new PeerLinkError({ reason, message: reason });

const sessionError = () =>
  new PeerEnvironmentRegistryError({ reason: "not_paired", message: "not paired" });

const deps = (input: {
  readonly link: Effect.Effect<{ url: string; token: string }, PeerLinkError>;
  readonly session?: Effect.Effect<{ url: string; token: string }, PeerEnvironmentRegistryError>;
}) => ({
  links: { resolve: () => input.link } as never,
  registry:
    input.session === undefined
      ? Option.none()
      : Option.some({ resolveSession: () => input.session! } as never),
});

describe("resolvePeerSession", () => {
  it.effect("prefers the ordinary link", () =>
    Effect.gen(function* () {
      const resolved = yield* resolvePeerSession(
        deps({ link: Effect.succeed({ url: "http://link.test", token: "link-token" }) }),
      )(environmentId);
      expect(resolved).toEqual({ url: "http://link.test", token: "link-token", from: "link" });
    }),
  );

  it.effect("falls back to the fleet delegation session for an unlinked worker", () =>
    Effect.gen(function* () {
      const resolved = yield* resolvePeerSession(
        deps({
          link: Effect.fail(linkError("unknown_link")),
          session: Effect.succeed({ url: "http://worker.test", token: "session-token" }),
        }),
      )(environmentId);
      expect(resolved).toEqual({
        url: "http://worker.test",
        token: "session-token",
        from: "registry",
      });
    }),
  );

  it.effect("reports an expired link instead of using another credential", () =>
    Effect.gen(function* () {
      const failure = yield* resolvePeerSession(
        deps({
          link: Effect.fail(linkError("expired")),
          session: Effect.succeed({ url: "http://worker.test", token: "session-token" }),
        }),
      )(environmentId).pipe(Effect.flip);
      expect(failure._tag).toBe("link");
      expect(failure._tag === "link" ? failure.error.reason : undefined).toBe("expired");
    }),
  );

  it.effect("has no fallback without a registry", () =>
    Effect.gen(function* () {
      const failure = yield* resolvePeerSession(
        deps({ link: Effect.fail(linkError("unknown_link")) }),
      )(environmentId).pipe(Effect.flip);
      expect(failure._tag).toBe("link");
    }),
  );

  it.effect("reports a registry failure when the worker has no session", () =>
    Effect.gen(function* () {
      const failure = yield* resolvePeerSession(
        deps({
          link: Effect.fail(linkError("unknown_link")),
          session: Effect.fail(sessionError()),
        }),
      )(environmentId).pipe(Effect.flip);
      expect(failure._tag).toBe("registry");
    }),
  );
});
