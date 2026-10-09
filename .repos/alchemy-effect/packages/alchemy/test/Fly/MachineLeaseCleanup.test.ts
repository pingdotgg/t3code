import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Fly from "@/Fly";
import { makeMachineLeases } from "@/Fly/leases";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import { assertAppGone } from "./fixtures/bluegreen.ts";
import { sanitizeExecFailure } from "./fixtures/exec-lease.ts";

const { test } = Test.make({ providers: Fly.providers() });

test.provider(
  "native lease cleanup waits for an in-flight renewal before releasing authority",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const target = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          return yield* Fly.Machine("Worker", {
            app,
            image: "nginx:alpine",
            region: "iad",
            skipLaunch: true,
          });
        }),
      );
      try {
        yield* Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const closed = yield* Deferred.make<void>();
          const client = yield* HttpClient.HttpClient;
          let acquisitions = 0;
          let releases = 0;
          const observed = HttpClient.transform(client, (response, request) =>
            Effect.gen(function* () {
              const path = request.url.split("?")[0]!;
              if (path.endsWith(`/machines/${target.machineId}/lease`)) {
                if (request.method === "POST") {
                  acquisitions++;
                  if (acquisitions === 2) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(resume);
                  }
                } else if (request.method === "DELETE") releases++;
              }
              return yield* response;
            }),
          );
          yield* Effect.gen(function* () {
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer((exit) =>
              Deferred.succeed(resume, undefined).pipe(
                Effect.andThen(Scope.close(scope, exit)),
              ),
            );
            const leases = yield* makeMachineLeases(target.appName).pipe(
              Effect.provideService(Scope.Scope, scope),
            );
            yield* leases.acquire([target.machineId]);
            yield* Effect.logInfo("Lease renewal probe", {
              phase: "acquired",
              acquisitions,
              releases,
            });
            yield* Deferred.await(entered).pipe(
              Effect.timeout("40 seconds"),
              Effect.tapError((error) =>
                Effect.logInfo("Lease renewal probe", {
                  phase: "await renewal",
                  acquisitions,
                  releases,
                  tag: error._tag,
                }),
              ),
            );
            const closing = yield* Scope.close(scope, Exit.void).pipe(
              Effect.tap(() => Deferred.succeed(closed, undefined)),
              Effect.forkScoped,
            );
            yield* Effect.sleep("200 millis");
            expect(yield* Deferred.isDone(closed)).toBe(false);
            expect(releases).toBe(0);
            const held = yield* machines
              .getMachineLease({
                app_name: target.appName,
                machine_id: target.machineId,
              })
              .pipe(Retry.none, Effect.timeout("10 seconds"));
            expect(typeof held.data?.nonce === "string").toBe(true);
            yield* Deferred.succeed(resume, undefined);
            yield* Fiber.join(closing).pipe(
              Effect.timeout("20 seconds"),
              Effect.tapError((error) =>
                Effect.logInfo("Lease renewal probe", {
                  phase: "await close",
                  acquisitions,
                  releases,
                  tag: error._tag,
                }),
              ),
            );
            expect(releases).toBe(1);
            expect(acquisitions).toBe(2);
            const absent = yield* machines
              .getMachineLease({
                app_name: target.appName,
                machine_id: target.machineId,
              })
              .pipe(
                Retry.none,
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
                Effect.timeout("10 seconds"),
              );
            expect(absent).toBe(true);
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, observed),
            Effect.scoped,
          );
        }).pipe(Effect.scoped);
      } finally {
        yield* stack.destroy();
        yield* assertAppGone(target.appName);
      }
    }).pipe(sanitizeExecFailure),
  {
    tags: ["provider:fly", "provider:fly:app", "provider:fly:machine", "live"],
    timeout: 240_000,
  },
);
