import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUsageLimits,
  UsageModelFilter,
  UsageSummaryInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { exhaustedUsageWindow, resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { AsyncResult } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { createEnvironmentPresentationAtoms } from "./presentation.ts";
import { executeAtomQuery, runAtomCommand, squashAtomCommandFailure } from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

/** The Usage tab asks each environment with that environment's configured model filter. */
export function usageSummaryInput(
  input: UsageSummaryInput,
  modelFilter: UsageModelFilter | undefined,
): UsageSummaryInput {
  return modelFilter === undefined ? input : { ...input, modelFilter };
}

const DEFAULT_MODEL_USAGE_WAIT_MS = 5_000;

export async function refreshNewThreadUsage({
  registry,
  server,
  environmentId,
  input,
}: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly server: Pick<ReturnType<typeof createServerEnvironmentAtoms>, "refreshProviders">;
  readonly environmentId: EnvironmentId;
  readonly input: Parameters<typeof resolveNewThreadModelSelection>[0];
}): Promise<readonly ServerProvider[]> {
  const { defaultSelection, fallbackSelection } = input;
  if (input.explicitSelection || !defaultSelection || !fallbackSelection) return input.providers;
  const refresh = async (instanceId: ProviderInstanceId) => {
    const result = await runAtomCommand(
      registry,
      server.refreshProviders,
      { environmentId, input: { instanceId, usage: true } },
      { reportFailure: false },
    );
    return AsyncResult.isSuccess(result) ? result.value.providers : undefined;
  };
  let providers = input.providers;
  let expired = false;
  const read = async () => {
    providers = (await refresh(defaultSelection.instanceId)) ?? providers;
    if (expired) return;
    if (
      exhaustedUsageWindow(
        providers.find((provider) => provider.instanceId === defaultSelection.instanceId),
        input.now,
        defaultSelection.model,
      )
    ) {
      providers = (await refresh(fallbackSelection.instanceId)) ?? providers;
    }
  };
  // The UI wait is bounded; an already shared read can still finish into the cache.
  await Effect.runPromise(
    Effect.promise(read).pipe(
      Effect.timeoutOption(DEFAULT_MODEL_USAGE_WAIT_MS),
      Effect.ensuring(
        Effect.sync(() => {
          expired = true;
        }),
      ),
    ),
  );
  return providers;
}

export function usageRefreshDeadline(
  limits: Iterable<ServerProviderUsageLimits | undefined>,
  serverTime?: number,
): number | undefined {
  // @effect-diagnostics-next-line globalDate:off
  const now = Date.now();
  const deadlines = Array.from(limits, (reading) => reading?.refreshAfter).filter(
    (deadline): deadline is number => deadline !== undefined && Number.isFinite(deadline),
  );
  return deadlines.length ? now + Math.min(...deadlines) - (serverTime ?? now) : undefined;
}

export function usageRefreshAccountKey(
  providers: readonly Pick<ServerProvider, "instanceId" | "instanceRevision" | "driver" | "auth">[],
  driver?: ProviderDriverKind | null,
  instanceId?: ProviderInstanceId | null,
  generation = 0,
) {
  return JSON.stringify([
    generation,
    providers
      .filter(
        (provider) =>
          (!driver || provider.driver === driver) &&
          (!instanceId || provider.instanceId === instanceId),
      )
      .sort((a, b) => a.instanceId.localeCompare(b.instanceId))
      .map((provider) => [
        provider.instanceId,
        provider.instanceRevision,
        provider.auth?.status,
        provider.auth?.type,
        provider.auth?.email?.toLowerCase(),
        provider.auth?.workspaceId,
        provider.auth?.usageRefreshKey,
      ]),
  ]);
}

const limitsRefreshAfter = new Map<string, number>();
const limitsRefreshes = new Map<string, Promise<unknown>>();

export function usageLimitsRefreshDelay(
  environmentId: EnvironmentId,
  selectionKey: string | readonly string[] = "",
): number {
  const selections =
    typeof selectionKey === "string" ? [selectionKey] : selectionKey.length ? selectionKey : [""];
  const refreshAfter = Math.min(
    ...selections.map(
      (selection) => limitsRefreshAfter.get(JSON.stringify([environmentId, selection])) ?? 0,
    ),
  );
  // @effect-diagnostics-next-line globalDate:off
  return Math.max(0, refreshAfter - Date.now());
}

export async function refreshUsageLimits<A>(
  environmentId: EnvironmentId,
  refresh: () => Promise<A>,
  automatic = false,
  afterPending = false,
  selectionKey:
    | string
    | {
        readonly key: string;
        readonly resources: readonly string[];
        readonly refreshDeadline?: (result: A) => number | undefined;
      } = "",
): Promise<A | undefined> {
  const selections =
    typeof selectionKey === "string"
      ? [selectionKey]
      : selectionKey.resources.length
        ? selectionKey.resources
        : [""];
  const key = JSON.stringify([
    environmentId,
    typeof selectionKey === "string" ? selectionKey : selectionKey.key,
  ]);
  const pending = limitsRefreshes.get(key);
  if (pending !== undefined) {
    if (afterPending) {
      try {
        await pending;
      } catch {}
      return refreshUsageLimits(environmentId, refresh, false, true, selectionKey);
    }
    return (await pending) as A;
  }
  if (automatic && usageLimitsRefreshDelay(environmentId, selections) > 0) return;
  const refreshedSelections =
    typeof selectionKey === "string"
      ? selections
      : selections.filter((selection) => usageLimitsRefreshDelay(environmentId, selection) === 0);
  let deadline: number | undefined;
  const current = Promise.resolve()
    .then(refresh)
    .then((result) => {
      if (typeof selectionKey !== "string") deadline = selectionKey.refreshDeadline?.(result);
      return result;
    })
    .finally(() => {
      limitsRefreshes.delete(key);
      // @effect-diagnostics-next-line globalDate:off
      const finishedAt = Date.now();
      const refreshAfter =
        deadline !== undefined
          ? Math.min(deadline, finishedAt + 5 * 60_000)
          : finishedAt + 5 * 60_000;
      for (const selection of refreshedSelections)
        limitsRefreshAfter.set(JSON.stringify([environmentId, selection]), refreshAfter);
    });
  limitsRefreshes.set(key, current);
  return await current;
}

export async function refreshUsage({
  registry,
  server,
  presentations,
  environmentIds,
  input,
}: {
  registry: AtomRegistry.AtomRegistry;
  server: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "usageSummary" | "refreshUsageRates" | "usageModelFilterAtom"
  >;
  presentations: Pick<ReturnType<typeof createEnvironmentPresentationAtoms>, "presentationAtom">;
  environmentIds: readonly EnvironmentId[];
  input: UsageSummaryInput;
}): Promise<void> {
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const query = server.usageSummary({
        environmentId,
        input: usageSummaryInput(input, registry.get(server.usageModelFilterAtom(environmentId))),
      });
      const presentation = presentations.presentationAtom(environmentId);
      const controller = new AbortController();
      const abortWhenDisconnected = () => {
        if (registry.get(presentation)?.connection.phase !== "connected") controller.abort();
      };
      const unsubscribe = registry.subscribe(presentation, abortWhenDisconnected);
      abortWhenDisconnected();
      try {
        const ratesResult = await runAtomCommand(
          registry,
          server.refreshUsageRates,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        const sessionUnavailable =
          ratesResult._tag === "Failure" &&
          isEnvironmentRpcUnavailable(squashAtomCommandFailure(ratesResult));
        registry.refresh(query);
        if (sessionUnavailable || controller.signal.aborted) return;
        await executeAtomQuery(registry, query, {
          reportFailure: false,
          signal: controller.signal,
        });
      } finally {
        unsubscribe();
      }
    }),
  );
}
