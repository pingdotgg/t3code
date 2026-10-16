import type {
  EnvironmentId,
  ServerProvider,
  UsageSummary,
  UsageSummaryInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { AtomRegistry } from "effect/reactivity";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { createEnvironmentPresentationAtoms } from "./presentation.ts";
import { executeAtomQuery, runAtomCommand, squashAtomCommandFailure } from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

export function needsCursorKeychainAccess(
  summary: UsageSummary | null,
  providers: readonly ServerProvider[] | null,
): boolean {
  return (
    summary?.sources.some((source) => source.action === "enableCursorKeychain") === true &&
    providers?.some((provider) => provider.driver === "cursor" && provider.status === "ready") ===
      true
  );
}

/**
 * Any environment reading a Cursor account already reports that account's
 * history from every machine, so the prompt only adds duplicates there.
 */
export function cursorKeychainAccessEnvironments<
  E extends { readonly summary: UsageSummary | null; readonly needsCursorKeychainAccess: boolean },
>(environments: readonly E[]): readonly E[] {
  const hasCursorAccount = environments.some((environment) =>
    environment.summary?.sources.some(
      (source) =>
        source.fingerprint.provider === "cursor" && source.fingerprint.hostId === "cursor.com",
    ),
  );
  return hasCursorAccount
    ? []
    : environments.filter((environment) => environment.needsCursorKeychainAccess);
}

const limitsRefreshAfter = new Map<EnvironmentId, number>();
const limitsRefreshes = new Map<EnvironmentId, Promise<unknown>>();

export async function refreshUsageLimits<A>(
  environmentId: EnvironmentId,
  refresh: () => Promise<A>,
  automatic = false,
  afterPending = false,
): Promise<A | undefined> {
  const pending = limitsRefreshes.get(environmentId);
  if (pending !== undefined) {
    if (afterPending) {
      try {
        await pending;
      } catch {}
      return refreshUsageLimits(environmentId, refresh, false, true);
    }
    return automatic ? undefined : ((await pending) as A);
  }
  const refreshAfter = limitsRefreshAfter.get(environmentId) ?? 0;
  // @effect-diagnostics-next-line globalDate:off
  if (automatic && Date.now() < refreshAfter) return;
  const current = Promise.resolve()
    .then(refresh)
    .finally(() => {
      limitsRefreshes.delete(environmentId);
      // @effect-diagnostics-next-line globalDate:off
      limitsRefreshAfter.set(environmentId, Date.now() + 5 * 60_000);
    });
  limitsRefreshes.set(environmentId, current);
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
    "usageSummary" | "refreshUsageRates"
  >;
  presentations: Pick<ReturnType<typeof createEnvironmentPresentationAtoms>, "presentationAtom">;
  environmentIds: readonly EnvironmentId[];
  input: UsageSummaryInput;
}): Promise<void> {
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const query = server.usageSummary({ environmentId, input });
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
