import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderQuotaConsumeResetError,
  PROVIDER_QUOTA_SUMMARY_MAX_INSTANCES,
  type ProviderQuotaConsumeResetOutcome,
  type ProviderQuotaSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderQuotaAdapterError, type ProviderQuotaCapability } from "../ProviderQuota.ts";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { ProviderQuotaService, layer } from "./ProviderQuotaService.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

const snapshot = (instanceId: string, driver = codex): ProviderQuotaSnapshot => {
  const readAt = "2026-08-11T08:00:00.000Z";
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    status: "current",
    source: "test",
    readAt,
    lastSuccessfulReadAt: readAt,
    headlineMetricKey: null,
    metrics: [],
    credits: null,
    bankedResets: null,
    detail: {},
    message: null,
  };
};

const makeInstance = (input: {
  readonly id: string;
  readonly driver?: typeof codex;
  readonly enabled?: boolean;
  readonly quota?: ProviderQuotaCapability;
}): ProviderInstance => {
  const driverKind = input.driver ?? codex;
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driverKind,
    continuationIdentity: { driverKind, continuationKey: `${input.id}:test` },
    displayName: undefined,
    enabled: input.enabled ?? true,
    snapshot: {} as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    ...(input.quota ? { quota: input.quota } : {}),
  };
};

const registryLayer = (list: () => ReadonlyArray<ProviderInstance>) =>
  Layer.succeed(
    ProviderInstanceRegistry,
    ProviderInstanceRegistry.of({
      getInstance: (id) => Effect.sync(() => list().find((instance) => instance.instanceId === id)),
      listInstances: Effect.sync(list),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.die("unused in quota service tests"),
    }),
  );

const provideService = (instances: () => ReadonlyArray<ProviderInstance>) =>
  Effect.provide(layer.pipe(Layer.provide(registryLayer(instances))));

describe("ProviderQuotaService", () => {
  it.effect("returns every enabled instance and represents unsupported providers honestly", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      const supported = makeInstance({
        id: "codex-enabled",
        quota: { read: Effect.succeed(snapshot("codex-enabled")), revision: Effect.succeed(0) },
      });
      const unsupported = makeInstance({ id: "claude-enabled", driver: claude });
      const disabled = makeInstance({ id: "codex-disabled", enabled: false });
      instances = [supported, unsupported, disabled];

      const service = yield* ProviderQuotaService;
      const summary = yield* service.readSummary;

      expect(summary.instances.map(({ instanceId }) => instanceId)).toEqual([
        supported.instanceId,
        unsupported.instanceId,
      ]);
      expect(summary.instances[1]).toMatchObject({
        status: "unknown",
        source: "unsupported",
        driver: claude,
      });
    }).pipe(provideService(() => instances));
  });

  it.effect("bounds the number of provider snapshots returned on the wire", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      instances = Array.from({ length: PROVIDER_QUOTA_SUMMARY_MAX_INSTANCES + 1 }, (_, index) =>
        makeInstance({ id: `provider-${index}` }),
      );
      const service = yield* ProviderQuotaService;

      const summary = yield* service.readSummary;

      expect(summary.instances).toHaveLength(PROVIDER_QUOTA_SUMMARY_MAX_INSTANCES);
    }).pipe(provideService(() => instances));
  });

  it.effect(
    "isolates provider failures and retains the last success as stale without leaking detail",
    () => {
      let instances: ReadonlyArray<ProviderInstance> = [];
      return Effect.gen(function* () {
        let nextRead: ProviderQuotaCapability["read"] = Effect.succeed(snapshot("codex-main"));
        const instance = makeInstance({
          id: "codex-main",
          quota: { read: Effect.suspend(() => nextRead), revision: Effect.succeed(0) },
        });
        instances = [instance];
        const service = yield* ProviderQuotaService;

        yield* service.readSummary;
        yield* service.invalidate(instance.instanceId);
        nextRead = Effect.fail(
          new ProviderQuotaAdapterError({
            reason: "providerFailed",
            detail: "TOKEN=secret C:\\Users\\private raw-provider-payload",
          }),
        );
        const summary = yield* service.readSummary;

        expect(summary.instances[0]).toMatchObject({
          status: "stale",
          lastSuccessfulReadAt: "2026-08-11T08:00:00.000Z",
          detail: { reason: "providerFailed" },
        });
        const publicFailureText = [
          ...Object.values(summary.instances[0]?.detail ?? {}),
          summary.instances[0]?.message ?? "",
        ].join(" ");
        expect(publicFailureText).not.toContain("secret");
        expect(publicFailureText).not.toContain("raw-provider-payload");
      }).pipe(provideService(() => instances));
    },
  );

  it.effect("maps a per-instance ten-second timeout without failing the summary", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      const instance = makeInstance({
        id: "codex-slow",
        quota: { read: Effect.never, revision: Effect.succeed(0) },
      });
      instances = [instance];
      const service = yield* ProviderQuotaService;
      const fiber = yield* service.readSummary.pipe(Effect.forkChild);

      yield* TestClock.adjust("10 seconds");
      const summary = yield* Fiber.join(fiber);

      expect(summary.instances[0]).toMatchObject({
        status: "error",
        detail: { reason: "timeout" },
      });
    }).pipe(provideService(() => instances));
  });

  it.effect("reuses snapshots until the thirty-second TestClock expiry", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      let reads = 0;
      const instance = makeInstance({
        id: "codex-cached",
        quota: {
          read: Effect.sync(() => {
            reads += 1;
            return snapshot("codex-cached");
          }),
          revision: Effect.succeed(0),
        },
      });
      instances = [instance];
      const service = yield* ProviderQuotaService;

      yield* service.readSummary;
      yield* TestClock.adjust("29 seconds");
      yield* service.readSummary;
      expect(reads).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* service.readSummary;
      expect(reads).toBe(2);
    }).pipe(provideService(() => instances));
  });

  it.effect("shares one in-flight provider read across concurrent summaries", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      let reads = 0;
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const instance = makeInstance({
        id: "codex-concurrent",
        quota: {
          read: Effect.gen(function* () {
            reads += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return snapshot("codex-concurrent");
          }),
          revision: Effect.succeed(0),
        },
      });
      instances = [instance];
      const service = yield* ProviderQuotaService;

      const first = yield* service.readSummary.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* service.readSummary.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(reads).toBe(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(reads).toBe(1);
    }).pipe(provideService(() => instances));
  });

  it.effect("does not strand later readers when an in-flight owner is interrupted", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      let attempts = 0;
      const firstStarted = yield* Deferred.make<void>();
      const instance = makeInstance({
        id: "codex-interrupted",
        quota: {
          read: Effect.gen(function* () {
            attempts += 1;
            if (attempts === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              return yield* Effect.never;
            }
            return snapshot("codex-interrupted");
          }),
          revision: Effect.succeed(0),
        },
      });
      instances = [instance];
      const service = yield* ProviderQuotaService;

      const owner = yield* service.readSummary.pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      yield* Fiber.interrupt(owner);

      const laterRead = yield* service.readSummary.pipe(
        Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(null) }),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(laterRead);

      expect(result?.instances[0]).toMatchObject({
        instanceId: instance.instanceId,
        status: "current",
      });
      expect(attempts).toBe(2);
    }).pipe(provideService(() => instances));
  });

  it.effect("does not publish an interrupt-only provider read as a stale failure", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      let reads = 0;
      const instance = makeInstance({
        id: "codex-interrupt-cause",
        quota: {
          read: Effect.suspend(() => {
            reads += 1;
            if (reads === 2) return Effect.failCause(Cause.interrupt(42));
            return Effect.succeed({
              ...snapshot("codex-interrupt-cause"),
              detail: { generation: reads === 1 ? "initial" : "recovered" },
            });
          }),
          revision: Effect.succeed(0),
        },
      });
      instances = [instance];
      const service = yield* ProviderQuotaService;

      yield* service.readSummary;
      yield* service.invalidate(instance.instanceId);
      const recovered = yield* service.readSummary;

      expect(recovered.instances[0]).toMatchObject({
        status: "current",
        detail: { generation: "recovered" },
      });
      expect(reads).toBe(3);
    }).pipe(provideService(() => instances));
  });

  it.effect("retries obsolete owners and waiters against a rebuilt instance identity", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      const oldStarted = yield* Deferred.make<void>();
      const releaseOld = yield* Deferred.make<void>();
      const oldInstance = makeInstance({
        id: "codex-rebuilt",
        quota: {
          read: Effect.gen(function* () {
            yield* Deferred.succeed(oldStarted, undefined);
            yield* Deferred.await(releaseOld);
            return { ...snapshot("codex-rebuilt"), detail: { account: "old" } };
          }),
          revision: Effect.succeed(0),
        },
      });
      const newInstance = makeInstance({
        id: "codex-rebuilt",
        quota: {
          read: Effect.succeed({
            ...snapshot("codex-rebuilt"),
            detail: { account: "new" },
          }),
          revision: Effect.succeed(0),
        },
      });
      instances = [oldInstance];
      const service = yield* ProviderQuotaService;

      const oldOwner = yield* service.readSummary.pipe(Effect.forkChild);
      yield* Deferred.await(oldStarted);
      const oldWaiter = yield* service.readSummary.pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      instances = [newInstance];
      const newResult = yield* service.readSummary;
      yield* Deferred.succeed(releaseOld, undefined);
      const ownerResult = yield* Fiber.join(oldOwner);
      const waiterResult = yield* Fiber.join(oldWaiter);

      for (const result of [newResult, ownerResult, waiterResult]) {
        expect(result.instances[0]?.detail).toEqual({ account: "new" });
      }
    }).pipe(provideService(() => instances));
  });

  it.effect("revalidates rebuilt identity before publishing without a second summary scan", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      const oldStarted = yield* Deferred.make<void>();
      const releaseOld = yield* Deferred.make<void>();
      const oldInstance = makeInstance({
        id: "codex-post-read-rebuild",
        quota: {
          read: Effect.gen(function* () {
            yield* Deferred.succeed(oldStarted, undefined);
            yield* Deferred.await(releaseOld);
            return {
              ...snapshot("codex-post-read-rebuild"),
              detail: { account: "old" },
            };
          }),
          revision: Effect.succeed(0),
        },
      });
      const newInstance = makeInstance({
        id: "codex-post-read-rebuild",
        quota: {
          read: Effect.succeed({
            ...snapshot("codex-post-read-rebuild"),
            detail: { account: "new" },
          }),
          revision: Effect.succeed(0),
        },
      });
      instances = [oldInstance];
      const service = yield* ProviderQuotaService;

      const owner = yield* service.readSummary.pipe(Effect.forkChild);
      yield* Deferred.await(oldStarted);
      const waiter = yield* service.readSummary.pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      instances = [newInstance];
      yield* Deferred.succeed(releaseOld, undefined);
      const ownerResult = yield* Fiber.join(owner);
      const waiterResult = yield* Fiber.join(waiter);

      for (const result of [ownerResult, waiterResult]) {
        expect(result.instances[0]?.detail).toEqual({ account: "new" });
      }
    }).pipe(provideService(() => instances));
  });

  it.effect("revalidates capability revision before publishing an in-flight read", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      let revision = 0;
      let attempts = 0;
      const oldStarted = yield* Deferred.make<void>();
      const releaseOld = yield* Deferred.make<void>();
      const instance = makeInstance({
        id: "codex-post-read-revision",
        quota: {
          read: Effect.gen(function* () {
            attempts += 1;
            if (attempts === 1) {
              yield* Deferred.succeed(oldStarted, undefined);
              yield* Deferred.await(releaseOld);
              return {
                ...snapshot("codex-post-read-revision"),
                detail: { generation: "old" },
              };
            }
            return {
              ...snapshot("codex-post-read-revision"),
              detail: { generation: "new" },
            };
          }),
          revision: Effect.sync(() => revision),
        },
      });
      instances = [instance];
      const service = yield* ProviderQuotaService;

      const owner = yield* service.readSummary.pipe(Effect.forkChild);
      yield* Deferred.await(oldStarted);
      const waiter = yield* service.readSummary.pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      revision = 1;
      yield* Deferred.succeed(releaseOld, undefined);
      const ownerResult = yield* Fiber.join(owner);
      const waiterResult = yield* Fiber.join(waiter);

      for (const result of [ownerResult, waiterResult]) {
        expect(result.instances[0]?.detail).toEqual({ generation: "new" });
      }
      expect(attempts).toBe(2);
    }).pipe(provideService(() => instances));
  });

  it.effect("fails a summary when provider generations never stabilize", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      let revision = 0;
      let reads = 0;
      const instance = makeInstance({
        id: "codex-churning",
        quota: {
          read: Effect.suspend(() => {
            reads += 1;
            if (reads > 5) return Effect.die("unbounded retry guard");
            revision += 1;
            return Effect.succeed(snapshot("codex-churning"));
          }),
          revision: Effect.sync(() => revision),
        },
      });
      instances = [instance];
      const service = yield* ProviderQuotaService;
      const result = yield* service.readSummary.pipe(Effect.result);

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "registryUnavailable" },
      });
      expect(reads).toBeLessThanOrEqual(4);
    }).pipe(provideService(() => instances));
  });

  it.effect(
    "bypasses cached data after revision, identity, and explicit invalidation changes",
    () => {
      let instances: ReadonlyArray<ProviderInstance> = [];
      return Effect.gen(function* () {
        let reads = 0;
        let revision = 0;
        const quota = {
          read: Effect.sync(() => {
            reads += 1;
            return snapshot("codex-changing");
          }),
          revision: Effect.sync(() => revision),
        } satisfies ProviderQuotaCapability;
        let instance = makeInstance({ id: "codex-changing", quota });
        instances = [instance];
        const service = yield* ProviderQuotaService;

        yield* service.readSummary;
        revision += 1;
        yield* service.readSummary;
        instance = makeInstance({ id: "codex-changing", quota });
        instances = [instance];
        yield* service.readSummary;
        yield* service.invalidate(instance.instanceId);
        yield* service.readSummary;

        expect(reads).toBe(4);
      }).pipe(provideService(() => instances));
    },
  );

  it.effect(
    "rejects missing, disabled, and unsupported reset targets with bounded safe errors",
    () => {
      let instances: ReadonlyArray<ProviderInstance> = [];
      return Effect.gen(function* () {
        const disabled = makeInstance({ id: "disabled", enabled: false });
        const unsupported = makeInstance({ id: "unsupported" });
        instances = [disabled, unsupported];
        const service = yield* ProviderQuotaService;
        const consume = (instanceId: string) =>
          service.consumeBankedReset({
            instanceId: ProviderInstanceId.make(instanceId),
            creditId: null,
            idempotencyKey: "request-1",
          });

        const missingError = yield* consume("missing").pipe(Effect.flip);
        const disabledError = yield* consume("disabled").pipe(Effect.flip);
        const unsupportedError = yield* consume("unsupported").pipe(Effect.flip);

        expect(missingError).toEqual(
          new ProviderQuotaConsumeResetError({
            reason: "instanceMissing",
            detail: "The provider instance does not exist.",
          }),
        );
        expect(disabledError.reason).toBe("instanceDisabled");
        expect(unsupportedError.reason).toBe("unsupported");
      }).pipe(provideService(() => instances));
    },
  );

  it.effect(
    "forwards one exact reset request and invalidates the instance after every typed outcome",
    () => {
      let instances: ReadonlyArray<ProviderInstance> = [];
      return Effect.gen(function* () {
        let reads = 0;
        let consumes = 0;
        let consumeResult: Effect.Effect<
          ProviderQuotaConsumeResetOutcome,
          ProviderQuotaAdapterError
        > = Effect.succeed("reset");
        let received:
          | { readonly creditId: string | null; readonly idempotencyKey: string }
          | undefined;
        const instance = makeInstance({
          id: "codex-reset",
          quota: {
            read: Effect.sync(() => {
              reads += 1;
              return {
                ...snapshot("codex-reset"),
                bankedResets: {
                  availableCount: 1,
                  detailsComplete: true,
                  resets: [
                    {
                      id: "credit-7",
                      title: null,
                      description: null,
                      grantedAt: "2026-08-11T00:00:00.000Z",
                      expiresAt: null,
                      resetType: "codexRateLimits",
                      status: "available" as const,
                    },
                  ],
                },
              };
            }),
            revision: Effect.succeed(0),
            consumeBankedReset: (input) =>
              Effect.sync(() => {
                consumes += 1;
                received = input;
              }).pipe(Effect.andThen(Effect.suspend(() => consumeResult))),
          },
        });
        instances = [instance];
        const service = yield* ProviderQuotaService;

        yield* service.readSummary;
        const outcome = yield* service.consumeBankedReset({
          instanceId: instance.instanceId,
          creditId: "credit-7",
          idempotencyKey: "request-7",
        });
        yield* service.readSummary;

        expect(outcome).toBe("reset");
        expect(consumes).toBe(1);
        expect(received).toEqual({ creditId: "credit-7", idempotencyKey: "request-7" });
        consumeResult = Effect.fail(
          new ProviderQuotaAdapterError({
            reason: "authRequired",
            detail: "TOKEN=secret C:\\Users\\private raw-provider-payload",
          }),
        );
        const error = yield* service
          .consumeBankedReset({
            instanceId: instance.instanceId,
            creditId: null,
            idempotencyKey: "request-8",
          })
          .pipe(Effect.flip);
        yield* service.readSummary;

        expect(error).toEqual(
          new ProviderQuotaConsumeResetError({
            reason: "authRequired",
            detail: "Sign in to the provider before consuming a reset.",
          }),
        );
        expect(consumes).toBe(2);
        expect(reads).toBe(5);
      }).pipe(provideService(() => instances));
    },
  );

  it.effect("rejects reset consumption unless the latest capability snapshot is current", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      let consumes = 0;
      const stale = {
        ...snapshot("codex-reset"),
        status: "stale" as const,
        bankedResets: {
          availableCount: 1,
          detailsComplete: true,
          resets: [
            {
              id: "credit-7",
              title: null,
              description: null,
              grantedAt: "2026-08-11T00:00:00.000Z",
              expiresAt: null,
              resetType: "codexRateLimits",
              status: "available" as const,
            },
          ],
        },
      };
      instances = [
        makeInstance({
          id: "codex-reset",
          quota: {
            read: Effect.succeed(stale),
            revision: Effect.succeed(0),
            consumeBankedReset: () => Effect.sync(() => consumes++).pipe(Effect.as("reset")),
          },
        }),
      ];
      const service = yield* ProviderQuotaService;

      const error = yield* service
        .consumeBankedReset({
          instanceId: ProviderInstanceId.make("codex-reset"),
          creditId: "credit-7",
          idempotencyKey: "request-7",
        })
        .pipe(Effect.flip);

      expect(error.reason).toBe("providerFailed");
      expect(consumes).toBe(0);
    }).pipe(provideService(() => instances));
  });

  it.effect("times out a reset eligibility refresh that never settles", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      instances = [
        makeInstance({
          id: "codex-reset",
          quota: {
            read: Effect.never,
            revision: Effect.succeed(0),
            consumeBankedReset: () => Effect.succeed("reset"),
          },
        }),
      ];
      const service = yield* ProviderQuotaService;
      const fiber = yield* service
        .consumeBankedReset({
          instanceId: ProviderInstanceId.make("codex-reset"),
          creditId: null,
          idempotencyKey: "request-7",
        })
        .pipe(
          Effect.result,
          Effect.timeoutOrElse({
            duration: "11 seconds",
            orElse: () => Effect.succeed("outer-timeout"),
          }),
          Effect.forkChild,
        );

      yield* TestClock.adjust("11 seconds");
      const result = yield* Fiber.join(fiber);

      expect(result).not.toBe("outer-timeout");
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "providerFailed" },
      });
    }).pipe(provideService(() => instances));
  });

  it.effect("times out a reset mutation that never settles", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      instances = [
        makeInstance({
          id: "codex-reset",
          quota: {
            read: Effect.succeed({
              ...snapshot("codex-reset"),
              bankedResets: { availableCount: 1, resets: [], detailsComplete: false },
            }),
            revision: Effect.succeed(0),
            consumeBankedReset: () => Effect.never,
          },
        }),
      ];
      const service = yield* ProviderQuotaService;
      const fiber = yield* service
        .consumeBankedReset({
          instanceId: ProviderInstanceId.make("codex-reset"),
          creditId: null,
          idempotencyKey: "request-7",
        })
        .pipe(
          Effect.result,
          Effect.timeoutOrElse({
            duration: "11 seconds",
            orElse: () => Effect.succeed("outer-timeout"),
          }),
          Effect.forkChild,
        );

      yield* TestClock.adjust("11 seconds");
      const result = yield* Fiber.join(fiber);

      expect(result).not.toBe("outer-timeout");
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "providerFailed" },
      });
    }).pipe(provideService(() => instances));
  });

  it.effect("rejects a reset credit that is no longer available in current inventory", () => {
    let instances: ReadonlyArray<ProviderInstance> = [];
    return Effect.gen(function* () {
      let consumes = 0;
      instances = [
        makeInstance({
          id: "codex-reset",
          quota: {
            read: Effect.succeed({
              ...snapshot("codex-reset"),
              bankedResets: { availableCount: 0, resets: [], detailsComplete: true },
            }),
            revision: Effect.succeed(0),
            consumeBankedReset: () => Effect.sync(() => consumes++).pipe(Effect.as("reset")),
          },
        }),
      ];
      const service = yield* ProviderQuotaService;

      const error = yield* service
        .consumeBankedReset({
          instanceId: ProviderInstanceId.make("codex-reset"),
          creditId: "credit-7",
          idempotencyKey: "request-7",
        })
        .pipe(Effect.flip);

      expect(error.reason).toBe("providerFailed");
      expect(consumes).toBe(0);
    }).pipe(provideService(() => instances));
  });
});
