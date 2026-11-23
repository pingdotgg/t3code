import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { provideAtomRuntime, runInEnvironment } from "@t3tools/client-runtime/state/runtime";
import { ThreadSnapshotLoader } from "@t3tools/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAppForeground } from "../../lib/appState";
import { appAtomRegistry } from "../../state/atom-registry";
import type { AgentWidgetSnapshot } from "../agentWidgetSnapshot";
import { selectWidgetMessagePreview } from "./widgetMessagePreview";
import type { WorkMessagePreview, WorkThread } from "./workSnapshot";

function previewTargets(snapshot: AgentWidgetSnapshot) {
  const targets = new Map<
    string,
    {
      row: Pick<WorkThread, "environmentId" | "threadId" | "deepLink">;
      version: string;
    }
  >();
  const waiting = snapshot.activities.filter((row) => row.phase.startsWith("waiting"));
  const working = snapshot.activities.filter(
    (row) => row.phase === "running" || row.phase === "starting",
  );
  for (const row of [...waiting.slice(0, 2), ...working.slice(0, waiting.length ? 1 : 2)]) {
    targets.set(row.deepLink, { row, version: `${row.turnId ?? ""}:${row.phase}` });
  }
  for (const row of [...(snapshot.work?.review ?? []), ...(snapshot.work?.recent ?? [])]) {
    targets.set(row.deepLink, { row, version: `${row.updatedAt}:${row.phase}` });
  }
  return [...targets.values()].sort((a, b) => a.row.deepLink.localeCompare(b.row.deepLink));
}

type PreviewTarget = ReturnType<typeof previewTargets>[number];
type PreviewCache = Readonly<
  Record<
    string,
    {
      readonly version: string;
      readonly checkedAt: number;
      readonly message: WorkMessagePreview | null;
    }
  >
>;

const ACTIVE_PREVIEW_TTL_MS = 9 * 60_000;
const SETTLED_PREVIEW_TTL_MS = 30 * 60_000;

const loadWidgetMessage = Effect.fn("mobile.loadWidgetMessage")(function* (
  row: PreviewTarget["row"],
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) return undefined;
  const loader = yield* ThreadSnapshotLoader;
  const result = yield* loader.load(prepared.value, row.threadId);
  if (result._tag === "missing") return null;
  if (result._tag === "unavailable") return undefined;
  return selectWidgetMessagePreview(result.snapshot.projection.visibleTurnItems);
});

function fetchPreviews(
  targets: readonly PreviewTarget[],
  signal: AbortSignal,
  onResult: (target: PreviewTarget, message: WorkMessagePreview | null) => void,
) {
  return Effect.runPromise(
    Effect.forEach(
      targets,
      (target) =>
        runInEnvironment(target.row.environmentId, loadWidgetMessage(target.row)).pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.tap((message) =>
            Effect.sync(() => {
              if (!signal.aborted && message !== undefined) onResult(target, message);
            }),
          ),
        ),
      { concurrency: 2, discard: true },
    ).pipe(provideAtomRuntime(appAtomRegistry, connectionAtomRuntime)),
    { signal },
  );
}

export function useWidgetMessagePreviews(
  snapshot: AgentWidgetSnapshot,
  liveEnvironmentKey: string,
  refreshTick: number,
) {
  const active = useAppForeground();
  const targets = useMemo(() => previewTargets(snapshot), [snapshot]);
  const requestKey = targets.length
    ? JSON.stringify([refreshTick, targets.map(({ row, version }) => [row.deepLink, version])])
    : null;
  const results = useRef<PreviewCache>({});
  const [cache, setCache] = useState<PreviewCache>({});
  const refresh = useEffectEvent((signal: AbortSignal) => {
    const live = new Set(liveEnvironmentKey.split("\n"));
    const inFlight = new Set(
      snapshot.activities
        .filter(
          (row) =>
            row.phase === "running" || row.phase === "starting" || row.phase.startsWith("waiting"),
        )
        .map((row) => row.deepLink),
    );
    const now = Date.now();
    const pending = targets.filter(({ row, version }) => {
      const entry = results.current[row.deepLink];
      const ttl = inFlight.has(row.deepLink) ? ACTIVE_PREVIEW_TTL_MS : SETTLED_PREVIEW_TTL_MS;
      return (
        live.has(row.environmentId) && (entry?.version !== version || now - entry.checkedAt >= ttl)
      );
    });
    const publish = () => {
      if (signal.aborted) return;
      results.current = Object.fromEntries(
        targets.flatMap(({ row }) => {
          const entry = results.current[row.deepLink];
          return entry ? [[row.deepLink, entry]] : [];
        }),
      );
      setCache(results.current);
    };
    if (pending.length === 0) {
      publish();
      return;
    }
    void fetchPreviews(pending, signal, ({ row, version }, message) => {
      results.current = {
        ...results.current,
        [row.deepLink]: { version, checkedAt: now, message },
      };
    })
      .then(publish)
      .catch((error: unknown) => {
        if (!signal.aborted) console.warn("Could not update widget message previews", error);
      });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the widget excerpts when visible threads change
  useEffect(() => {
    if (!active || !liveEnvironmentKey || requestKey === null) return;
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [active, liveEnvironmentKey, requestKey]);

  return useMemo(
    () =>
      Object.fromEntries(
        targets.flatMap(({ row, version }) => {
          const entry = cache[row.deepLink];
          return entry
            ? [[row.deepLink, entry.version === version ? entry.message : null] as const]
            : [];
        }),
      ),
    [cache, targets],
  );
}
