import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { chooseLoadBalancedEnvironment } from "@t3tools/client-runtime/load-balancing";
import type { EnvironmentId, HostResourcesSnapshot } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { ServerIcon } from "lucide-react";
import { useContext, useEffect } from "react";

import { cn } from "~/lib/utils";
import { useClientSettings } from "../../../hooks/useSettings";
import { useQuietThreadShells } from "../../../state/entities";
import { useEnvironments } from "../../../state/environments";
import { serverEnvironment } from "../../../state/server";
import { resolveThreadStatusPill } from "../../Sidebar.logic";
import { DitherCanvas } from "./DitherCanvas";
import { bayer, drawDitherField, drawDottedLine } from "./dither";
import {
  appendHostSample,
  formatGigabytes,
  HOST_HISTORY_MS,
  type HostSample,
} from "./heroWidgets.logic";
import { GHOST, readStored, useDebugValue, WidgetCard, writeStored } from "./widgetChrome";

const POLL_MS = 5_000;
const SPARK = "color-mix(in oklab, var(--primary) 30%, #6f8fff)";
const HISTORY_KEY = "t3code:hero-widgets:host-samples:v1";
const hostHistory = new Map<string, ReadonlyArray<HostSample>>(
  Object.entries(readStored<Record<string, HostSample[]>>(HISTORY_KEY, {})),
);
const lastSeen = new Map<string, number>();

const hostResourcesListAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    (environmentIdsKey === "" ? [] : (environmentIdsKey.split("\n") as EnvironmentId[])).map(
      (environmentId) => {
        const result = get(serverEnvironment.hostResources({ environmentId, input: {} }));
        return {
          environmentId,
          resources: result._tag === "Success" ? result.value : null,
          receivedAt: result._tag === "Success" ? result.timestamp : 0,
          failed: result._tag === "Failure",
        };
      },
    ),
  ),
);

function recordSample(environmentId: string, resources: HostResourcesSnapshot, receivedAt: number) {
  if (lastSeen.get(environmentId) === resources.sampledAt) return;
  lastSeen.set(environmentId, resources.sampledAt);
  const memoryUsed =
    resources.totalMemoryBytes > 0
      ? 1 - resources.availableMemoryBytes / resources.totalMemoryBytes
      : 0;
  hostHistory.set(
    environmentId,
    appendHostSample(hostHistory.get(environmentId) ?? [], {
      t: receivedAt,
      cpu: resources.cpuUtilization,
      memoryUsed,
    }),
  );
  writeStored(HISTORY_KEY, Object.fromEntries(hostHistory));
}

export function MachinesWidget({ now }: { readonly now: number }) {
  const { environments } = useEnvironments();
  const weights = useClientSettings((settings) => settings.loadBalancingWeights);
  const registry = useContext(RegistryContext);
  const connectedIds = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  const idsKey = connectedIds.join("\n");
  const resources = useAtomValue(hostResourcesListAtom(idsKey));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls host load so the sparkline builds up while the new-chat screen is open
  useEffect(() => {
    const ids = idsKey === "" ? [] : (idsKey.split("\n") as EnvironmentId[]);
    const id = window.setInterval(() => {
      for (const environmentId of ids) {
        registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [idsKey, registry]);

  for (const entry of resources) {
    if (entry.resources) recordSample(entry.environmentId, entry.resources, entry.receivedAt);
  }

  const next = chooseLoadBalancedEnvironment(
    resources.map((entry) => ({ ...entry, weight: weights[entry.environmentId] ?? 50 })),
    // Polling keeps receipts fresh; the latest receipt stands in for the clock between ticks.
    Math.max(now, ...resources.map((entry) => entry.receivedAt)),
  );

  const threads = useQuietThreadShells();
  const running = new Map<string, number>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    const pill = resolveThreadStatusPill({ thread });
    if (pill?.label === "Working" || pill?.label === "Connecting") {
      running.set(thread.environmentId, (running.get(thread.environmentId) ?? 0) + 1);
    }
  }
  const resourcesById = new Map(resources.map((entry) => [entry.environmentId, entry]));
  const online = connectedIds.length;
  useDebugValue("machines", {
    next,
    resources,
    history: Object.fromEntries([...hostHistory].map(([id, samples]) => [id, samples.length])),
  });

  return (
    <WidgetCard
      id="machines"
      icon={ServerIcon}
      title="Machines"
      meta={`${online} of ${environments.length} online`}
    >
      <ul className="mt-1 flex min-h-0 flex-1 flex-col divide-y divide-border/60">
        {environments.map((environment) => {
          const entry = resourcesById.get(environment.environmentId);
          return (
            <MachineRow
              key={environment.environmentId}
              label={environment.label}
              phase={environment.connection.phase}
              resources={entry?.resources ?? null}
              failed={entry?.failed ?? false}
              history={hostHistory.get(environment.environmentId) ?? []}
              agents={running.get(environment.environmentId) ?? 0}
              isNext={next === environment.environmentId}
              now={now}
              compact={environments.length >= 3}
            />
          );
        })}
      </ul>
    </WidgetCard>
  );
}

interface MachineRowProps {
  readonly label: string;
  readonly phase: string;
  readonly resources: HostResourcesSnapshot | null;
  readonly failed: boolean;
  readonly history: ReadonlyArray<HostSample>;
  readonly agents: number;
  readonly isNext: boolean;
  readonly now: number;
  /** Three or more machines share the card, one line each. */
  readonly compact: boolean;
}

function MachineRow(props: MachineRowProps) {
  const { label, phase, resources, failed, history, agents, isNext, now, compact } = props;
  const connected = phase === "connected";
  const cpu = resources?.cpuUtilization ?? null;
  const memoryUsed =
    resources && resources.totalMemoryBytes > 0
      ? 1 - resources.availableMemoryBytes / resources.totalMemoryBytes
      : null;
  const name = (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-xs",
          connected ? "bg-success" : "bg-muted-foreground/40",
          phase === "connecting" && "animate-pulse",
        )}
      />
      <span className="truncate text-sm font-medium">{label}</span>
      {isNext ? (
        <span className="shrink-0 rounded-full border border-primary/40 bg-primary/15 px-1.5 text-3xs leading-4 text-primary">
          next chat
        </span>
      ) : null}
    </span>
  );
  const detail = resources
    ? compact
      ? `${resources.cpuCount} cores · ${formatGigabytes(resources.availableMemoryBytes)} free · ${agents} running`
      : `${resources.cpuCount} cores · ${formatGigabytes(resources.availableMemoryBytes)} free of ${formatGigabytes(resources.totalMemoryBytes)} · ${agents} agent${agents === 1 ? "" : "s"} running`
    : connected
      ? failed
        ? "Load unavailable"
        : "Reading load…"
      : phase;
  const cpuLabel = (
    <span className="text-sm font-semibold tabular-nums">
      {cpu === null ? "–" : `${Math.round(cpu * 100)}%`}
      <span className="ms-1 text-2xs font-normal text-muted-foreground">CPU</span>
    </span>
  );

  if (compact) {
    return (
      <li className="grid min-h-0 flex-1 grid-cols-[minmax(0,11rem)_minmax(0,1fr)_4.5rem] items-center gap-3 py-1.5">
        <span className="min-w-0">
          {name}
          <span className="block truncate text-2xs text-muted-foreground tabular-nums">
            {detail}
          </span>
        </span>
        <CpuSparkline history={history} now={now} className="h-full max-h-12 min-h-5" />
        <span className="flex flex-col items-end gap-1">
          {cpuLabel}
          <MemoryBar used={memoryUsed} className="h-1.5 w-full" />
        </span>
      </li>
    );
  }

  return (
    <li className="flex min-h-0 flex-1 flex-col gap-1.5 py-2.5 first:pt-2 last:pb-0">
      <div className="flex items-center gap-2">
        {name}
        <span className="ms-auto">{cpuLabel}</span>
      </div>
      <div className="truncate text-xs text-muted-foreground tabular-nums">{detail}</div>
      <CpuSparkline history={history} now={now} className="min-h-5 flex-1" showCeiling />
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_2.5rem] items-center gap-2 text-2xs text-muted-foreground tabular-nums">
        <span>RAM</span>
        <MemoryBar used={memoryUsed} className="h-2.5" />
        <span className="text-right">
          {memoryUsed === null ? "–" : `${Math.round(memoryUsed * 100)}%`}
        </span>
      </div>
    </li>
  );
}

function CpuSparkline({
  history,
  now,
  className,
  showCeiling = false,
}: {
  readonly history: ReadonlyArray<HostSample>;
  readonly now: number;
  readonly className: string;
  readonly showCeiling?: boolean;
}) {
  const peak = Math.max(0, ...history.map((sample) => sample.cpu ?? 0));
  const ceiling = Math.max(0.25, Math.min(1, peak * 1.25));
  const drawNow = Math.max(now, history.at(-1)?.t ?? 0);
  return (
    <div className={cn("relative", className)}>
      <DitherCanvas
        className="h-full"
        label={`CPU over the last ${HOST_HISTORY_MS / 60_000} minutes`}
        draw={(context, { width, height }, color) => {
          const cell = 3;
          const rows = Math.floor(height / cell);
          const columns = Math.floor(width / cell);
          const fill = color(SPARK);
          const crest = color(`color-mix(in oklab, ${SPARK} 55%, white)`);
          drawDottedLine(context, [0, 0], [width, 0], color(GHOST), 6, 1);
          context.fillStyle = color("color-mix(in oklab, var(--foreground) 12%, transparent)");
          context.fillRect(0, rows * cell - 1, width, 1);
          let index = 0;
          for (let column = 0; column < columns; column += 1) {
            const t = drawNow - HOST_HISTORY_MS + ((column + 0.5) / columns) * HOST_HISTORY_MS;
            while (index + 1 < history.length && history[index + 1]!.t <= t) index += 1;
            const sample = history[index];
            if (!sample || sample.t > t || t - sample.t > 15_000 || sample.cpu === null) continue;
            const filled = Math.max(
              1,
              Math.round((Math.min(ceiling, sample.cpu) / ceiling) * rows),
            );
            const first = rows - filled;
            for (let row = first; row < rows; row += 1) {
              const depth = (row - first) / Math.max(1, rows - 1);
              const density = row === first ? 1 : 0.7 - 0.45 * depth;
              if (density <= bayer(column, row)) continue;
              context.fillStyle = row === first ? crest : fill;
              context.fillRect(column * cell, row * cell, cell - 1, cell - 1);
            }
          }
        }}
      />
      {showCeiling ? (
        <span className="pointer-events-none absolute top-0.5 right-0 text-3xs text-muted-foreground tabular-nums">
          {Math.round(ceiling * 100)}%
        </span>
      ) : null}
    </div>
  );
}

function MemoryBar({
  used,
  className,
}: {
  readonly used: number | null;
  readonly className: string;
}) {
  return (
    <DitherCanvas
      className={className}
      label="Memory in use"
      draw={(context, { width, height }, color) => {
        const share = used ?? 0;
        const columns = Math.floor(width / 3);
        drawDitherField(
          context,
          { x: 0, y: 0, width, height },
          (column) => (column < columns * share ? 0.95 - (column / columns) * 0.25 : 0),
          color(
            share > 0.9 ? "var(--warning)" : `color-mix(in oklab, ${SPARK} 75%, var(--foreground))`,
          ),
          { ghost: color(GHOST) },
        );
      }}
    />
  );
}
