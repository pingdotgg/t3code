import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Fly from "@/Fly";
import { makeMachineLeases } from "@/Fly/leases";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { assertAppGone } from "./fixtures/bluegreen.ts";
import { transportProxy, type TransportEvent } from "./fixtures/transport.ts";

const { test } = Test.make({ providers: Fly.providers() });

const targets = Effect.gen(function* () {
  const app = yield* Fly.App("LeaseSite");
  return yield* Fly.Machine("LeaseTargets", {
    app,
    region: "iad",
    image: "nginx:alpine",
    guest: { cpus: 1, memoryMb: 256 },
    count: 2,
    skipLaunch: true,
  });
});

const sanitizeFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new Error(
          error instanceof Error ? error.name : "Fly lease regression failed",
        ),
    ),
  );

const isLease = (machineId: string) => (event: TransportEvent) =>
  event.method === "POST" &&
  event.path.endsWith(`/machines/${machineId}/lease`);

const isAbsent = (event: TransportEvent) =>
  event.status === 404 || event.state === "destroyed";

// Faults hold or drop real responses; no Fly status, lease, or nonce is fabricated.
describe.sequential(
  "native lease controller concurrency",
  {
    tags: ["provider:fly", "provider:fly:app", "provider:fly:machine", "live"],
  },
  () => {
    for (const confirmed of [true, false]) {
      test.provider(
        confirmed
          ? "FLY-REVIEW-2 a late absence timeout cannot override confirmed removal"
          : "FLY-REVIEW-2 unconfirmed removal still cancels shared authority",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const created = yield* stack.deploy(targets);
            const [removedId, siblingId] = [...created.machineIds].sort();
            expect(created.machineIds).toHaveLength(2);
            const target = {
              app_name: created.appName,
              machine_id: removedId!,
            };
            const sibling = {
              app_name: created.appName,
              machine_id: siblingId!,
            };
            yield* Effect.gen(function* () {
              const first = yield* transportProxy();
              const second = yield* transportProxy();
              const client = yield* HttpClient.HttpClient;
              let observations = 0;
              const routed = HttpClient.mapRequest(client, (request) => {
                if (!request.url.startsWith("https://api.machines.dev/"))
                  return request;
                const observing =
                  request.method === "GET" &&
                  request.url.endsWith(`/machines/${removedId}`);
                const proxy = observing && ++observations > 1 ? second : first;
                return HttpClientRequest.setUrl(
                  request,
                  request.url.replace("https://api.machines.dev", proxy.url),
                );
              });
              yield* Effect.gen(function* () {
                const leases = yield* makeMachineLeases(created.appName);
                yield* leases.acquire(created.machineIds);
                const before = yield* machines
                  .getMachineLease(sibling)
                  .pipe(Retry.none);
                const deleting = (event: TransportEvent) =>
                  event.method === "DELETE" &&
                  event.path.endsWith(`/machines/${removedId}`);
                const observing = (event: TransportEvent) =>
                  event.method === "GET" &&
                  event.path.endsWith(`/machines/${removedId}`);
                yield* Effect.sync(() => {
                  first.arm({
                    match: deleting,
                    action: "drop-response",
                    remaining: 1,
                  });
                  first.arm({
                    match: observing,
                    action: "hold-response",
                    remaining: 1,
                  });
                  second.arm({
                    match: observing,
                    action: "hold-response",
                    remaining: Infinity,
                  });
                });
                // Start absence observation just before the target's first renewal.
                yield* leases.guard(Effect.sleep("20 seconds"));
                const removal = yield* leases
                  .remove(removedId!, (lease_nonce) =>
                    machines.deleteMachine({
                      ...target,
                      lease_nonce,
                      force: true,
                    }),
                  )
                  .pipe(Effect.result, Effect.forkScoped);
                const dropped = yield* first.wait(
                  (event) => deleting(event) && event.stage === "dropped",
                );
                expect(dropped.status! >= 200 && dropped.status! < 300).toBe(
                  true,
                );
                const initialObservation = yield* first.wait(
                  (event) => observing(event) && event.stage === "held",
                );
                expect(isAbsent(initialObservation)).toBe(true);
                const lateObservation = yield* second.wait(
                  (event) => observing(event) && event.stage === "held",
                );
                expect(isAbsent(lateObservation)).toBe(true);
                expect(
                  first.events.some(
                    (event) =>
                      isLease(removedId!)(event) &&
                      event.stage === "forwarded" &&
                      event.status === 404,
                  ),
                ).toBe(true);
                if (confirmed) {
                  yield* Effect.sync(first.release);
                  const removed = yield* Fiber.join(removal).pipe(
                    Effect.timeout("5 seconds"),
                  );
                  expect(Result.isSuccess(removed)).toBe(true);
                  expect(yield* leases.nonceIfHeld(removedId!)).toBeUndefined();
                }
                // The renewal observer remains held until its own 30-second deadline.
                const outcome = yield* leases
                  .guard(Effect.sleep("32 seconds"))
                  .pipe(Effect.result);
                expect(Result.isSuccess(outcome)).toBe(confirmed);
                if (Result.isFailure(outcome)) {
                  expect(outcome.failure._tag).toBe("Fly.MachineLeaseLost");
                  expect(outcome.failure.machineId).toBe(removedId);
                  expect(outcome.failure.reason).toBe(
                    "lease disappeared before removal was confirmed",
                  );
                }
                expect(
                  second.events.some(
                    (event) => observing(event) && event.stage === "forwarded",
                  ),
                ).toBe(false);
                if (confirmed) {
                  yield* leases.checkTarget(siblingId!);
                  const after = yield* machines
                    .getMachineLease(sibling)
                    .pipe(Retry.none);
                  expect(after.data?.expires_at).toBeGreaterThan(
                    before.data!.expires_at!,
                  );
                  expect(
                    first.events.some(
                      (event) =>
                        isLease(siblingId!)(event) &&
                        event.stage === "forwarded" &&
                        event.sequence > dropped.sequence &&
                        event.status! >= 200 &&
                        event.status! < 300,
                    ),
                  ).toBe(true);
                } else {
                  const removed = yield* Fiber.join(removal).pipe(
                    Effect.timeout("5 seconds"),
                  );
                  expect(Result.isFailure(removed)).toBe(true);
                }
                expect(
                  first.events.filter(
                    (event) => deleting(event) && event.stage === "request",
                  ),
                ).toHaveLength(1);
              }).pipe(
                Effect.scoped,
                Effect.provideService(HttpClient.HttpClient, routed),
              );
            }).pipe(Effect.scoped);
            yield* stack.destroy();
            yield* assertAppGone(created.appName);
          }).pipe(sanitizeFailure),
        { timeout: 300_000 },
      );
    }

    test.provider(
      "FLY-REVIEW-4 held renewal responses do not consume another target's renewal interval",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const created = yield* stack.deploy(targets);
          const [a, b] = [...created.machineIds].sort();
          expect(created.machineIds).toHaveLength(2);
          yield* Effect.gen(function* () {
            const first = yield* transportProxy();
            const second = yield* transportProxy();
            const client = yield* HttpClient.HttpClient;
            const routed = HttpClient.mapRequest(client, (request) => {
              if (!request.url.startsWith("https://api.machines.dev/"))
                return request;
              const proxy = request.url.includes(`/machines/${a}/`)
                ? first
                : second;
              return HttpClientRequest.setUrl(
                request,
                request.url.replace("https://api.machines.dev", proxy.url),
              );
            });
            yield* Effect.gen(function* () {
              const leases = yield* makeMachineLeases(created.appName);
              yield* leases.acquire(created.machineIds);
              let renewalsA = 0;
              yield* Effect.sync(() => {
                first.arm({
                  match: (event) => isLease(a!)(event) && ++renewalsA === 2,
                  action: "hold-response",
                  remaining: 1,
                });
                second.arm({
                  match: isLease(b!),
                  action: "hold-response",
                  remaining: 1,
                });
              });
              const heldB = yield* leases.guard(
                second.wait(
                  (event) => isLease(b!)(event) && event.stage === "held",
                ),
              );
              expect(heldB.status! >= 200 && heldB.status! < 300).toBe(true);
              const heldAt = yield* Clock.currentTimeMillis;
              const releaseB = yield* Effect.sleep("60 seconds").pipe(
                Effect.andThen(Effect.sync(second.release)),
                Effect.forkScoped,
              );
              const heldA = yield* leases
                .guard(
                  first.wait(
                    (event) => isLease(a!)(event) && event.stage === "held",
                  ),
                )
                .pipe(Effect.timeout("45 seconds"));
              expect(heldA.status! >= 200 && heldA.status! < 300).toBe(true);
              expect((yield* Clock.currentTimeMillis) - heldAt).toBeLessThan(
                45_000,
              );
              expect(
                second.events.some(
                  (event) =>
                    event.sequence === heldB.sequence &&
                    event.stage === "forwarded",
                ),
              ).toBe(false);
              const releaseA = yield* Effect.sleep("60 seconds").pipe(
                Effect.andThen(Effect.sync(first.release)),
                Effect.forkScoped,
              );
              yield* leases.guard(
                Effect.all([Fiber.join(releaseA), Fiber.join(releaseB)]),
              );
              yield* leases.guard(Effect.sleep("5 seconds"));
              for (const machineId of created.machineIds)
                yield* leases.checkTarget(machineId);
              for (const [proxy, held, machineId] of [
                [first, heldA, a!],
                [second, heldB, b!],
              ] as const) {
                const forwarded = proxy.events.findIndex(
                  (event) =>
                    event.sequence === held.sequence &&
                    event.stage === "forwarded",
                );
                const started = proxy.events.findIndex(
                  (event) =>
                    event.sequence === held.sequence && event.stage === "held",
                );
                expect(forwarded).toBeGreaterThan(started);
                expect(
                  proxy.events
                    .slice(started + 1, forwarded)
                    .some(
                      (event) =>
                        isLease(machineId)(event) && event.stage === "request",
                    ),
                ).toBe(false);
                expect(
                  proxy.events
                    .slice(forwarded + 1)
                    .some(
                      (event) =>
                        isLease(machineId)(event) &&
                        event.stage === "forwarded" &&
                        event.status! >= 200 &&
                        event.status! < 300,
                    ),
                ).toBe(true);
              }
            }).pipe(
              Effect.scoped,
              Effect.provideService(HttpClient.HttpClient, routed),
            );
          }).pipe(Effect.scoped);
          yield* stack.destroy();
          yield* assertAppGone(created.appName);
        }).pipe(sanitizeFailure),
      { timeout: 300_000 },
    );
  },
);
