import {
  BadGateway,
  GatewayTimeout,
  InternalServerError,
  ServiceUnavailable,
  TooManyRequests,
} from "@distilled.cloud/fly-io/Errors";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const TTL_SECONDS = 120;
const EXPIRY_MARGIN_MS = 15_000;

const retrySchedule = <E>(): Schedule.Schedule<Duration.Duration, E> =>
  Schedule.exponential("500 millis").pipe(
    Schedule.modifyDelay<Duration.Duration, E>(({ input, duration }) =>
      Effect.succeed(
        (input instanceof TooManyRequests ||
          input instanceof InternalServerError ||
          input instanceof BadGateway ||
          input instanceof ServiceUnavailable ||
          input instanceof GatewayTimeout) &&
          input.retryAfter
          ? Math.min(Duration.toMillis(input.retryAfter), 60_000)
          : Math.min(Duration.toMillis(duration), 5_000),
      ),
    ),
    Schedule.addDelay<Duration.Duration, E>(() =>
      Effect.sync(() => Duration.millis(Math.random() * 50)),
    ),
  );

export class MachineLeaseBusy extends Data.TaggedError("Fly.MachineLeaseBusy")<{
  appName: string;
  machineId: string;
}> {}

export class MachineLeaseLost extends Data.TaggedError("Fly.MachineLeaseLost")<{
  appName: string;
  machineId: string;
  reason: string;
}> {
  get message() {
    return `Machine lease authority lost for ${this.appName}/${this.machineId}: ${this.reason}`;
  }
}

export class MachineMutationUncertain extends Data.TaggedError(
  "Fly.MachineMutationUncertain",
)<{
  appName: string;
  machineId: string;
}> {}

interface HeldLease {
  nonce: string;
  deadline: number;
  renewAt: number;
}

export const makeMachineLeases = Effect.fn(function* (appName: string) {
  const scope = yield* Effect.scope;
  const held = new Map<string, HeldLease>();
  const deleting = new Set<string>();
  const renewals = new Set<Fiber.Fiber<void, never>>();
  const uncertain = new Set<string>();
  const lost = yield* Deferred.make<never, MachineLeaseLost>();
  let failure: MachineLeaseLost | undefined;
  const lose = (machineId: string, reason: string) =>
    Effect.gen(function* () {
      failure ??= new MachineLeaseLost({ appName, machineId, reason });
      yield* Deferred.fail(lost, failure);
      return yield* Effect.fail(failure);
    });
  const check = Effect.gen(function* () {
    if (failure) return yield* Effect.fail(failure);
    const now = yield* Clock.currentTimeMillis;
    for (const [machineId, lease] of held) {
      if (now >= lease.deadline)
        return yield* lose(machineId, "lease authority expired");
    }
  });
  const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    check.pipe(Effect.andThen(Effect.raceFirst(effect, Deferred.await(lost))));
  const record = (
    machineId: string,
    response: machines.MachineLease,
    requestedAt: number,
  ) =>
    Effect.gen(function* () {
      const lease = response.data;
      const now = yield* Clock.currentTimeMillis;
      const deadline =
        Math.min(
          (lease?.expires_at ?? 0) * 1000,
          requestedAt + TTL_SECONDS * 1000,
        ) - EXPIRY_MARGIN_MS;
      const captured = lease?.nonce
        ? { nonce: lease.nonce, deadline, renewAt: requestedAt + 25_000 }
        : undefined;
      if (captured) held.set(machineId, captured);
      if (!captured || !Number.isFinite(deadline) || deadline <= now) {
        return yield* lose(machineId, "invalid or expired lease response");
      }
      return captured;
    });
  const acquire = (machineIds: readonly string[]) =>
    Effect.gen(function* () {
      for (const machineId of [...new Set(machineIds)].sort()) {
        yield* check;
        if (held.has(machineId)) continue;
        // Save a returned nonce atomically; uncertain interrupted requests expire at Fly.
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const requestedAt = yield* Clock.currentTimeMillis;
            const response = yield* restore(
              machines
                .createMachineLease({
                  app_name: appName,
                  machine_id: machineId,
                  ttl: TTL_SECONDS,
                  description: "Alchemy Machine lifecycle",
                })
                .pipe(
                  Retry.none,
                  Effect.retry({
                    times: 8,
                    schedule: retrySchedule<machines.CreateMachineLeaseError>(),
                    while: (error) =>
                      error._tag === "Conflict" ||
                      error._tag === "TooManyRequests",
                  }),
                  Effect.timeout("30 seconds"),
                  Effect.catchTag("Conflict", () =>
                    Effect.fail(new MachineLeaseBusy({ appName, machineId })),
                  ),
                  Effect.catchTag(
                    ["HttpClientError", "GatewayTimeout", "TimeoutError"],
                    (error) =>
                      lose(machineId, `acquisition uncertain: ${error._tag}`),
                  ),
                ),
            );
            const lease = yield* record(machineId, response, requestedAt);
            const renewal = yield* heartbeat(machineId, lease).pipe(
              Effect.interruptible,
              Effect.forkIn(scope),
            );
            renewals.add(renewal);
          }),
        );
        yield* check;
      }
    });
  const nonce = (machineId: string) =>
    Effect.gen(function* () {
      yield* check;
      const lease = held.get(machineId);
      if (!lease)
        return yield* lose(
          machineId,
          "target is outside the acquired lease set",
        );
      return lease.nonce;
    });
  const mutate = <A, E extends { readonly _tag: string }, R>(
    machineId: string,
    operation: (nonce: string) => Effect.Effect<A, E, R>,
    options: { idempotent?: boolean; timeoutMs?: number } = {},
  ) =>
    guard(
      Effect.gen(function* () {
        const value = yield* nonce(machineId);
        return yield* operation(value).pipe(Retry.none);
      }).pipe(
        Effect.retry({
          times: 8,
          schedule: retrySchedule<E | MachineLeaseLost>(),
          // Only explicit throttling is safe to replay for update/stop/delete.
          while: (error) =>
            error._tag === "TooManyRequests" ||
            (options.idempotent === true &&
              (error._tag === "InternalServerError" ||
                error._tag === "BadGateway" ||
                error._tag === "ServiceUnavailable" ||
                error._tag === "GatewayTimeout")),
        }),
        Effect.timeout(options.timeoutMs ?? 120_000),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error._tag === "Conflict" || error._tag === "Forbidden") {
              return yield* lose(
                machineId,
                `leased mutation rejected: ${error._tag}`,
              );
            }
            // Transport errors retain the request, including its private nonce header.
            if (
              error._tag === "HttpClientError" ||
              error._tag === "GatewayTimeout" ||
              error._tag === "TimeoutError"
            ) {
              return yield* new MachineMutationUncertain({
                appName,
                machineId,
              });
            }
            return yield* Effect.fail(error);
          }),
        ),
      ),
    );
  const forget = (machineId: string) =>
    Effect.sync(() => {
      held.delete(machineId);
    });
  const confirmRemoved = (machineId: string) =>
    guard(
      machines
        .getMachine({
          app_name: appName,
          machine_id: machineId,
        })
        .pipe(
          Retry.none,
          Effect.map(
            (machine) =>
              machine.id === machineId && machine.state === "destroyed",
          ),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.catchTag(
            [
              "TooManyRequests",
              "InternalServerError",
              "BadGateway",
              "ServiceUnavailable",
              "GatewayTimeout",
            ],
            () => Effect.succeed(false),
          ),
          Effect.catchTag("HttpClientError", (error) =>
            error.reason._tag === "TransportError"
              ? Effect.succeed(false)
              : Effect.fail(error),
          ),
          Effect.repeat({
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
            until: (absent) => absent,
          }),
          Effect.timeout("30 seconds"),
          Effect.catchTag("TimeoutError", () => Effect.succeed(false)),
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (!held.has(machineId)) return true;
              if (error._tag === "Forbidden") {
                return yield* lose(machineId, "removal observation forbidden");
              }
              return yield* Effect.fail(error);
            }),
          ),
          // Another observer's confirmed removal wins over a late uncertain response.
          Effect.map((absent) => absent || !held.has(machineId)),
          Effect.tap((absent) => (absent ? forget(machineId) : Effect.void)),
        ),
    );
  const remove = <A, E extends { readonly _tag: string }, R>(
    machineId: string,
    operation: (nonce: string) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const fetchOptions = yield* Effect.serviceOption(
        FetchHttpClient.RequestInit,
      );
      yield* Effect.sync(() => {
        deleting.add(machineId);
      });
      yield* mutate(machineId, (nonce) =>
        operation(nonce).pipe(
          // Bun can replay DELETE on a reused socket below the SDK retry policy.
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.mapRequest(
              http,
              HttpClientRequest.setHeader("connection", "close"),
            ),
          ),
          Effect.provideService(FetchHttpClient.RequestInit, {
            ...Option.getOrUndefined(fetchOptions),
            keepalive: false,
            redirect: "error",
          }),
        ),
      ).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error._tag === "NotFound") return yield* forget(machineId);
            if (
              error._tag === "Fly.MachineMutationUncertain" ||
              error._tag === "InternalServerError" ||
              error._tag === "BadGateway" ||
              error._tag === "ServiceUnavailable"
            ) {
              // Keep renewal aware of the removal until its exact target has been observed.
              if (yield* confirmRemoved(machineId)) return;
            }
            return yield* Effect.fail(error);
          }),
        ),
      );
      yield* forget(machineId);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          deleting.delete(machineId);
        }),
      ),
    );
  const nonceIfHeld = (machineId: string) =>
    check.pipe(Effect.map(() => held.get(machineId)?.nonce));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      // A late refresh can recreate a lease after a successful release.
      yield* Fiber.interruptAll(renewals);
      yield* Effect.forEach(
        [...held.entries()]
          .filter(([machineId]) => !uncertain.has(machineId))
          .sort(([a], [b]) => a.localeCompare(b)),
        ([machineId, lease]) =>
          machines
            .machinesReleaseLease({
              app_name: appName,
              machine_id: machineId,
              lease_nonce: lease.nonce,
            })
            .pipe(
              Retry.none,
              Effect.timeout("5 seconds"),
              Effect.interruptible,
              Effect.catchTag("NotFound", () => Effect.void),
              Effect.catch((error) =>
                Effect.logWarning(
                  "Fly lease release was not confirmed; expiry remains the safety bound",
                  { appName, machineId, error: error._tag },
                ),
              ),
              Effect.asVoid,
            ),
        { concurrency: 4 },
      );
      if (uncertain.size > 0)
        yield* Effect.logWarning(
          "Fly lease renewal was not confirmed; expiry remains the safety bound",
          { appName, machineIds: [...uncertain] },
        );
    }),
  );

  const refresh = (machineId: string, lease: HeldLease) =>
    Effect.gen(function* () {
      yield* check;
      if (held.get(machineId) !== lease) return;
      const requestedAt = yield* Clock.currentTimeMillis;
      const response = yield* machines
        .createMachineLease({
          app_name: appName,
          machine_id: machineId,
          ttl: TTL_SECONDS,
          lease_nonce: lease.nonce,
          description: "Alchemy Machine lifecycle",
        })
        .pipe(Retry.none);
      if (held.get(machineId) !== lease) return;
      if (response.data?.nonce !== lease.nonce) {
        return yield* lose(machineId, "refresh returned a different nonce");
      }
      return yield* record(machineId, response, requestedAt);
    }).pipe(
      Effect.retry({
        times: 8,
        schedule: retrySchedule<
          machines.CreateMachineLeaseError | MachineLeaseLost
        >(),
        while: (error) => error._tag === "TooManyRequests",
      }),
      Effect.timeout("75 seconds"),
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (held.get(machineId) !== lease) return;
          uncertain.add(machineId);
          // A missing lease during removal is not proof that the Machine is gone.
          if (error._tag === "NotFound" && deleting.has(machineId)) {
            const absent = yield* confirmRemoved(machineId).pipe(
              Effect.catch((observation) =>
                held.get(machineId) === lease
                  ? lose(
                      machineId,
                      `removal observation uncertain: ${observation._tag}`,
                    )
                  : Effect.succeed(true),
              ),
            );
            if (absent || held.get(machineId) !== lease) return;
            return yield* lose(
              machineId,
              "lease disappeared before removal was confirmed",
            );
          }
          return yield* lose(machineId, `refresh uncertain: ${error._tag}`);
        }),
      ),
      (operation) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const pending = yield* operation.pipe(
              Effect.interruptible,
              Effect.forkChild,
            );
            return yield* Fiber.join(pending);
          }),
        ),
    );
  // Each target renews serially on its own cadence within the operation scope.
  const heartbeat = (machineId: string, acquired: HeldLease) =>
    Effect.gen(function* () {
      let lease: HeldLease | undefined = acquired;
      while (lease && held.get(machineId) === lease) {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Math.max(0, lease.renewAt - now));
        lease = yield* refresh(machineId, lease);
      }
    }).pipe(Effect.catch(() => Effect.void));
  yield* Effect.sleep("1 second").pipe(
    Effect.andThen(check),
    Effect.forever,
    Effect.catch(() => Effect.void),
    Effect.forkScoped,
  );
  const checkTarget = (machineId: string) =>
    nonce(machineId).pipe(Effect.asVoid);
  return {
    acquire,
    check,
    checkTarget,
    guard,
    mutate,
    remove,
    forget,
    nonceIfHeld,
  };
});

export type MachineLeases = Effect.Success<
  ReturnType<typeof makeMachineLeases>
>;

export const usingMachineLeases = <A, E, R>(
  appName: string,
  existing: MachineLeases | undefined,
  use: (leases: MachineLeases) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (existing)
      return yield* existing.guard(Effect.suspend(() => use(existing)));
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const leases = yield* makeMachineLeases(appName);
        return yield* leases.guard(Effect.suspend(() => use(leases)));
      }),
    );
  });
