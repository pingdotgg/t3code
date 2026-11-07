import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  makeUsageHttpClient,
  resolveUsageLimitsAfterProbe,
} from "@t3tools/provider-core/server/usageLimits";
import { readGrokAccount } from "./usageLimits.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "Grok usage account ownership",
  (it) => {
    it.effect.each([false, true])(
      "keeps quota ownership across cached reads and token renewal (email: %s)",
      (withEmail) =>
        Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const finish = yield* Deferred.make<void>();
            let requests = 0;
            const client = yield* makeUsageHttpClient(
              HttpClient.make((request) =>
                Effect.gen(function* () {
                  requests += 1;
                  if (requests > 2)
                    return HttpClientResponse.fromWeb(
                      request,
                      new Response(null, { status: 503, headers: { "retry-after": "600" } }),
                    );
                  const first = request.headers.authorization === "Bearer account-a";
                  if (first) {
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(finish);
                  }
                  return HttpClientResponse.fromWeb(
                    request,
                    Response.json({ config: { creditUsagePercent: first ? 80 : 25 } }),
                  );
                }),
              ),
            );
            const read = (key: string) =>
              readGrokAccount({
                HOME: "/unused-grok-home",
                GROK_AUTH: JSON.stringify({
                  "https://accounts.x.ai/sign-in": {
                    key,
                    ...(withEmail
                      ? { email: key.startsWith("account-a") ? "a@example.com" : "b@example.com" }
                      : {}),
                  },
                }),
              }).pipe(
                Effect.provideService(HttpClient.HttpClient, client),
                Effect.provideService(
                  FileSystem.FileSystem,
                  FileSystem.makeNoop({ readFileString: () => Effect.succeed("") }),
                ),
              );
            const pending = yield* read("account-a").pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* TestClock.adjust("1 second");
            const previous = yield* read("account-b");
            yield* TestClock.adjust("1 second");
            yield* Deferred.succeed(finish, undefined);
            const first = yield* Fiber.join(pending);
            yield* TestClock.adjust("299 seconds");
            const cached = yield* read("account-a");
            expect(requests).toBe(2);
            expect(cached.usageLimits.checkedAt).toBe(first.usageLimits.checkedAt);
            const selected = resolveUsageLimitsAfterProbe({
              published: previous.usageLimits,
              probed: cached.usageLimits,
            });
            expect(selected?.windows[0]?.usedPercent).toBe(80);
            const failed = yield* read("account-b");
            expect(failed.usageLimits.unavailable?.reason).toBe("probeFailed");
            expect(failed.usageLimits.credentialFingerprint).toBeTruthy();
            expect(failed.usageLimits.credentialFingerprint).toBe(
              previous.usageLimits.credentialFingerprint,
            );
            expect(failed.usageLimits.credentialFingerprint).not.toBe(
              cached.usageLimits.credentialFingerprint,
            );
            expect(
              resolveUsageLimitsAfterProbe({ published: selected, probed: failed.usageLimits })
                ?.windows,
            ).toEqual([]);
            const renewed = yield* read("account-b-renewed");
            expect(requests).toBe(withEmail ? 3 : 4);
            const retained = resolveUsageLimitsAfterProbe({
              published: previous.usageLimits,
              probed: renewed.usageLimits,
            });
            expect(retained?.windows.map((window) => window.usedPercent)).toEqual(
              withEmail ? [25] : [],
            );
            expect(retained?.stale).toBe(withEmail ? true : undefined);
          }),
        ),
    );
  },
);
