import {
  ProviderDriverKind,
  ServerProviderUpdateError,
  type ServerProvider,
  type ServerProviderUpdatedPayload,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { Cause, Effect, Ref } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ProcessRunResult } from "../processRunner.ts";
import { runProcess } from "../processRunner.ts";
import type { ProviderRegistryShape } from "./Services/ProviderRegistry.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "./providerVersionLifecycle.ts";
import type { ProviderVersionLifecycle } from "./providerVersionLifecycle.ts";

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;
const SHARED_UPDATE_LOCK_KEYS = ["npm-global", "bun-global", "cursor-agent"] as const;

export type ProviderUpdateRunner = (
  command: string,
  args: ReadonlyArray<string>,
) => Promise<ProcessRunResult>;

export interface ProviderUpdaterShape {
  readonly updateProvider: (
    provider: ProviderDriverKind,
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
}

const defaultRunner: ProviderUpdateRunner = (command, args) =>
  runProcess(command, args, {
    timeoutMs: UPDATE_TIMEOUT_MS,
    maxBufferBytes: UPDATE_OUTPUT_MAX_BYTES,
    outputMode: "truncate",
    allowNonZeroExit: true,
  });

function trimNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function commandOutput(result: ProcessRunResult): string | null {
  const output = trimNullable([result.stderr, result.stdout].filter(Boolean).join("\n\n"));
  if (!output) {
    return null;
  }
  return truncateText(output, UPDATE_OUTPUT_MAX_BYTES);
}

function failureMessage(result: ProcessRunResult): string {
  if (result.timedOut) {
    return "Update timed out.";
  }
  if (result.code !== null && result.code !== 0) {
    return `Update command exited with code ${result.code}.`;
  }
  if (result.signal) {
    return `Update command ended with signal ${result.signal}.`;
  }
  return "Update command failed.";
}

function isOutdatedProvider(provider: ServerProvider | undefined): boolean {
  return provider?.versionAdvisory?.status === "behind_latest";
}

function makeUpdateState(input: {
  readonly status: ServerProviderUpdateState["status"];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output?: string | null;
}): ServerProviderUpdateState {
  return {
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    message: input.message,
    output: input.output ?? null,
  };
}

export const makeProviderUpdater = Effect.fn("makeProviderUpdater")(function* (input: {
  readonly providerRegistry: ProviderRegistryShape;
  readonly runUpdate?: ProviderUpdateRunner;
}) {
  const runningProvidersRef = yield* Ref.make<ReadonlySet<ProviderDriverKind>>(new Set());
  const updateLocks = new Map<string, Semaphore.Semaphore>(
    yield* Effect.forEach(SHARED_UPDATE_LOCK_KEYS, (updateLockKey) =>
      Semaphore.make(1).pipe(Effect.map((semaphore) => [updateLockKey, semaphore] as const)),
    ),
  );
  const runUpdate = input.runUpdate ?? defaultRunner;

  const acquireProvider = Effect.fn("acquireProvider")(function* (provider: ProviderDriverKind) {
    return yield* Ref.modify(runningProvidersRef, (runningProviders) => {
      if (runningProviders.has(provider)) {
        return [false, runningProviders] as const;
      }
      const next = new Set(runningProviders);
      next.add(provider);
      return [true, next] as const;
    });
  });

  const releaseProvider = (provider: ProviderDriverKind) =>
    Ref.update(runningProvidersRef, (runningProviders) => {
      const next = new Set(runningProviders);
      next.delete(provider);
      return next;
    });

  const verifyRefreshedProvider = (
    provider: ProviderDriverKind,
    versionLifecycle: ProviderVersionLifecycle,
  ): Effect.Effect<VerifiedProviderRefresh> =>
    input.providerRegistry.getProviders.pipe(
      Effect.map((providers) =>
        providers
          .filter((candidate) => candidate.driver === provider)
          .map((candidate) => candidate.instanceId),
      ),
      Effect.flatMap((instanceIds) =>
        instanceIds.length === 0
          ? input.providerRegistry.refresh(provider)
          : Effect.forEach(
              instanceIds,
              (instanceId) => input.providerRegistry.refreshInstance(instanceId),
              {
                concurrency: "unbounded",
                discard: true,
              },
            ).pipe(Effect.andThen(input.providerRegistry.getProviders)),
      ),
      Effect.flatMap((providers) => {
        const refreshedProviders = providers.filter((candidate) => candidate.driver === provider);
        if (refreshedProviders.length === 0) {
          return Effect.succeed<VerifiedProviderRefresh>({
            providers,
            verifiedProviders: [],
          });
        }
        return Effect.forEach(
          refreshedProviders,
          (refreshedProvider) =>
            Effect.promise<ServerProvider>(() =>
              enrichProviderSnapshotWithVersionAdvisory(refreshedProvider, versionLifecycle),
            ),
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.map(
            (verifiedProviders): VerifiedProviderRefresh => ({
              providers,
              verifiedProviders,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider post-update version verification failed", {
              provider,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<VerifiedProviderRefresh>({
                providers,
                verifiedProviders: refreshedProviders,
              }),
            ),
          ),
        );
      }),
    );

  const updateProvider: ProviderUpdaterShape["updateProvider"] = (provider) =>
    Effect.gen(function* () {
      const lifecycle = yield* input.providerRegistry.getProviderVersionLifecycle(provider);
      const updateExecutable = lifecycle.updateExecutable;
      const updateLockKey = lifecycle.updateLockKey;
      if (!updateExecutable || !updateLockKey) {
        return yield* new ServerProviderUpdateError({
          provider,
          reason: "This provider does not support one-click updates.",
        });
      }

      const acquired = yield* acquireProvider(provider);
      if (!acquired) {
        return yield* new ServerProviderUpdateError({
          provider,
          reason: "An update is already running for this provider.",
        });
      }

      const lock = updateLocks.get(updateLockKey);
      if (!lock) {
        yield* releaseProvider(provider);
        return yield* new ServerProviderUpdateError({
          provider,
          reason: `Unsupported provider update lock key: ${updateLockKey}`,
        });
      }

      yield* input.providerRegistry.setProviderUpdateState(
        provider,
        makeUpdateState({
          status: "queued",
          startedAt: null,
          finishedAt: null,
          message: "Waiting for another provider update to finish.",
        }),
      );

      const finish = (state: ServerProviderUpdateState) =>
        input.providerRegistry
          .setProviderUpdateState(provider, state)
          .pipe(Effect.map((providers) => ({ providers })));
      const startedAtRef = yield* Ref.make<string | null>(null);

      const run = Effect.gen(function* () {
        const startedAt = new Date().toISOString();
        yield* Ref.set(startedAtRef, startedAt);
        yield* input.providerRegistry.setProviderUpdateState(
          provider,
          makeUpdateState({
            status: "running",
            startedAt,
            finishedAt: null,
            message: "Updating provider.",
          }),
        );

        const result = yield* Effect.promise<ProcessRunResult>(() =>
          runUpdate(updateExecutable, lifecycle.updateArgs),
        );
        const finishedAt = new Date().toISOString();
        if (result.timedOut || result.code !== 0) {
          return yield* finish(
            makeUpdateState({
              status: "failed",
              startedAt,
              finishedAt,
              message: failureMessage(result),
              output: commandOutput(result),
            }),
          );
        }

        const { verifiedProviders } = yield* verifyRefreshedProvider(provider, lifecycle);
        const couldNotVerify = verifiedProviders.length === 0;
        const stillOutdated =
          couldNotVerify ||
          verifiedProviders.some((verifiedProvider) => isOutdatedProvider(verifiedProvider));
        return yield* finish(
          makeUpdateState({
            status: stillOutdated ? "unchanged" : "succeeded",
            startedAt,
            finishedAt,
            message: couldNotVerify
              ? "Update command completed, but T3 Code could not verify the provider version."
              : stillOutdated
                ? "Update command completed, but T3 Code still detects an outdated provider version."
                : "Provider updated.",
            output: commandOutput(result),
          }),
        );
      });

      return yield* lock
        .withPermits(1)(run)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const failure = Cause.squash(cause);
              const startedAt = yield* Ref.get(startedAtRef);
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: new Date().toISOString(),
                  message: failure instanceof Error ? failure.message : "Update command failed.",
                  output: null,
                }),
              );
            }),
          ),
          Effect.ensuring(releaseProvider(provider)),
        );
    });

  return {
    updateProvider,
  } satisfies ProviderUpdaterShape;
});
