import { useAtomValue } from "@effect/atom-react";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { MachineStatus, ServerProvider } from "@t3tools/contracts";
import { type MachineLimit, recommendNextMachine } from "@t3tools/shared/machineCapacity";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { useGT } from "gt-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { machineEnvironmentsAtom } from "../../state/machineStatus";
import { environmentPresentations } from "../../state/presentation";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { describeAutoRoute } from "../chat/autoRoute";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type AccountUsage,
  claudeAccountUsage,
  type MachineChip,
  machineChips,
} from "./machineBar.logic";

type Translate = ReturnType<typeof useGT>;

const GIB = 1024 ** 3;
const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

function gigabytes(bytes: number): string {
  return `${(bytes / GIB).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} GB`;
}

function dotClassName(chip: MachineChip): string {
  switch (chip.capacity?.level) {
    case "room":
      return "bg-success";
    case "full":
      return "bg-warning";
    case "pressure":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

function limitLabel(limit: MachineLimit, gt: Translate): string {
  switch (limit) {
    case "cap":
      return gt("agent limit reached");
    case "memory":
      return gt("memory reserve reached");
    case "memoryPressure":
      return gt("memory pressure");
    case "cpu":
      return gt("CPU busy");
    case "io":
      return gt("disk busy");
  }
}

function waitReason(limits: ReadonlyArray<MachineLimit>, gt: Translate): string {
  if (limits.length === 0) return gt("no data");
  if (limits.every((limit) => limit === "cap" || limit === "memory")) return gt("all full");
  return limits.map((limit) => limitLabel(limit, gt)).join(", ");
}

function percentClassName(percent: number | null): string | undefined {
  if (percent === null) return undefined;
  if (percent >= 100) return "text-destructive";
  return percent >= 90 ? "text-warning-foreground" : undefined;
}

function Percent({ value }: { readonly value: number | null }) {
  return (
    <span className={percentClassName(value)}>{value === null ? "–" : Math.round(value)}</span>
  );
}

function AccountChip({ account }: { readonly account: AccountUsage }) {
  const gt = useGT();
  const summary = gt(
    "Claude {account}: {session} of the 5-hour window and {weekly} of the week used",
    {
      account: account.label,
      session: account.session === null ? "–" : `${Math.round(account.session)}%`,
      weekly: account.weekly === null ? "–" : `${Math.round(account.weekly)}%`,
    },
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={summary} className="inline-flex gap-1" />}
      >
        <span className="font-medium text-foreground/80">{account.label}</span>
        <span>
          <Percent value={account.session} />
          <span aria-hidden>·</span>
          <Percent value={account.weekly} />
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{summary}</TooltipPopup>
    </Tooltip>
  );
}

// Usage limits ride on provider status pushes, so only this strip re-renders on them.
function ClaudeAccounts() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const accounts = claudeAccountUsage(collectLimitAccounts(presentations));
  if (accounts.length === 0) return null;
  return (
    <div className="hidden shrink-0 items-center gap-2.5 tabular-nums lg:flex">
      {accounts.map((account) => (
        <AccountChip key={account.key} account={account} />
      ))}
    </div>
  );
}

function NextMachine({
  chips,
  now,
}: {
  readonly chips: ReadonlyArray<MachineChip>;
  readonly now: number;
}) {
  const gt = useGT();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const next = recommendNextMachine(chips.map((chip) => ({ id: chip.key, status: chip.status })));
  const nextChip = next.kind === "start" ? chips.find((chip) => chip.key === next.id) : undefined;
  const providers = nextChip
    ? (presentations.get(nextChip.environmentId)?.serverConfig?.providers ?? EMPTY_PROVIDERS)
    : EMPTY_PROVIDERS;
  const route = nextChip
    ? describeAutoRoute({ entries: deriveProviderInstanceEntries(providers), now })
    : null;
  return (
    <div className="ml-auto min-w-0 truncate">
      {nextChip
        ? route
          ? gt("Next → {machine} · Auto: {model}", { machine: nextChip.name, model: route.label })
          : gt("Next → {machine}", { machine: nextChip.name })
        : gt("Next → wait ({reason})", {
            reason: waitReason(next.kind === "wait" ? next.limits : [], gt),
          })}
    </div>
  );
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground tabular-nums">{value}</dd>
    </>
  );
}

function MachineDetails({
  chip,
  status,
}: {
  readonly chip: MachineChip;
  readonly status: MachineStatus;
}) {
  const gt = useGT();
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(chip.environmentId));
  const capacity = chip.capacity;
  const providerName = (instanceId: string) => {
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    return provider ? resolveProviderInstanceDisplayName(provider) : instanceId;
  };
  const cpu = [
    status.load === null
      ? null
      : gt("load {one} · {five} · {fifteen} on {cores} cores", {
          one: status.load[0].toFixed(2),
          five: status.load[1].toFixed(2),
          fifteen: status.load[2].toFixed(2),
          cores: status.cores,
        }),
    status.cpuUtilization === null
      ? null
      : gt("{percent}% busy", { percent: Math.round(status.cpuUtilization * 100) }),
  ].filter((part) => part !== null);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-foreground">{status.hostname}</span>
        {chip.environmentLabel !== status.hostname ? (
          <span className="truncate text-muted-foreground">{chip.environmentLabel}</span>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <DetailRow label={gt("CPU")} value={cpu.join(" · ")} />
        <DetailRow
          label={gt("Memory")}
          value={gt("{available} free of {total}", {
            available: gigabytes(status.memory.availableBytes),
            total: gigabytes(status.memory.totalBytes),
          })}
        />
        {status.swap !== null && status.swap.totalBytes > 0 ? (
          <DetailRow
            label={gt("Swap")}
            value={gt("{used} used of {total}", {
              used: gigabytes(status.swap.usedBytes),
              total: gigabytes(status.swap.totalBytes),
            })}
          />
        ) : null}
        {status.disk !== null ? (
          <DetailRow
            label={gt("Disk")}
            value={gt("{free} free of {total}", {
              free: gigabytes(status.disk.freeBytes),
              total: gigabytes(status.disk.totalBytes),
            })}
          />
        ) : null}
        {status.pressure !== null ? (
          // The averages the room gates read: 1 minute for CPU and memory, 10 s for IO.
          <DetailRow
            label={gt("Pressure")}
            value={gt("CPU {cpu}% · memory {memory}% · IO {io}%", {
              cpu: status.pressure.cpu.avg60.toFixed(0),
              memory: status.pressure.memory.avg60.toFixed(0),
              io: status.pressure.io.avg10.toFixed(0),
            })}
          />
        ) : null}
        {capacity !== null ? (
          <DetailRow
            label={gt("Room")}
            value={
              capacity.more > 0
                ? gt("{count, plural, one {# more agent} other {# more agents}}", {
                    count: capacity.more,
                  })
                : limitLabel(capacity.limit, gt)
            }
          />
        ) : null}
        <DetailRow
          label={gt("Agent limit")}
          value={
            status.maxWorkingAgents === null
              ? gt("memory only")
              : gt("{working} of {limit} working", {
                  working: status.working,
                  limit: status.maxWorkingAgents,
                })
          }
        />
      </dl>
      {status.agents.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-border/60 pt-2">
          {status.agents.map((agent) => (
            <li key={agent.threadId} className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  agent.state === "working" ? "bg-success" : "bg-muted-foreground/40",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">{agent.title}</span>
              <span className="shrink-0 text-muted-foreground">
                {agent.state === "working" ? gt("working") : gt("open")}
                {agent.providerInstanceId === null
                  ? null
                  : ` · ${providerName(agent.providerInstanceId)}`}
              </span>
            </li>
          ))}
          {status.working + status.open > status.agents.length ? (
            <li className="text-muted-foreground">
              {gt("{count, plural, one {# more} other {# more}}", {
                count: status.working + status.open - status.agents.length,
              })}
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="border-t border-border/60 pt-2 text-muted-foreground">
          {gt("No agents are open.")}
        </p>
      )}
    </div>
  );
}

function MachineChipButton({ chip }: { readonly chip: MachineChip }) {
  const gt = useGT();
  const { status, capacity } = chip;
  const summary =
    status === null || capacity === null
      ? chip.loading
        ? gt("{machine}: waiting for data", { machine: chip.name })
        : gt("{machine}: offline or no data", { machine: chip.name })
      : gt(
          "{machine}: {working} working, {open} open, {free} free, {more, plural, =0 {no room for more agents} one {room for # more agent} other {room for # more agents}}",
          {
            machine: chip.name,
            working: status.working,
            open: status.open,
            free: gigabytes(status.memory.availableBytes),
            more: capacity.more,
          },
        );
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        closeDelay={120}
        render={
          <button
            type="button"
            aria-label={summary}
            className="inline-flex h-[18px] shrink-0 items-center gap-1.5 rounded-sm px-1 tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-accent"
          />
        }
      >
        <span className="font-medium text-foreground/80">{chip.name}</span>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClassName(chip))} />
        {status === null || capacity === null ? (
          chip.loading ? null : (
            <span>{gt("off")}</span>
          )
        ) : (
          <span>
            {status.maxWorkingAgents === null
              ? status.working
              : `${status.working}/${status.maxWorkingAgents}`}
            {` · ${gigabytes(status.memory.availableBytes)} · +${capacity.more}`}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" padding="compact" width="lg">
        {status === null ? (
          <p className="text-xs text-muted-foreground">
            {chip.loading
              ? summary
              : gt("{machine} is offline or sent no data.", { machine: chip.name })}
          </p>
        ) : (
          <MachineDetails chip={chip} status={status} />
        )}
      </PopoverPopup>
    </Popover>
  );
}

/** Fixed under the window's header row; the layout reserves `--machine-bar-height` for it. */
export function MachineBar() {
  const gt = useGT();
  const now = Date.parse(useNowMinute());
  const chips = machineChips(useAtomValue(machineEnvironmentsAtom), now);
  return (
    <div
      aria-label={gt("Machines")}
      role="region"
      className="fixed inset-x-0 top-(--workspace-topbar-height) z-30 hidden h-(--machine-bar-height) items-center gap-4 overflow-hidden bg-background px-3 text-2xs text-muted-foreground md:flex"
      data-machine-bar
    >
      <div className="flex shrink-0 items-center gap-2">
        {chips.map((chip) => (
          <MachineChipButton key={chip.key} chip={chip} />
        ))}
      </div>
      <ClaudeAccounts />
      <NextMachine chips={chips} now={now} />
    </div>
  );
}
