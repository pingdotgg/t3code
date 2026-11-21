import type { EnvironmentId, MachineStatus } from "@t3tools/contracts";
import { machineCapacity, type MachineCapacity } from "@t3tools/shared/machineCapacity";
import type { LimitAccount } from "@t3tools/shared/usageLimits";

import type { MachineEnvironment } from "../../state/machineStatus";
import { claudeAccountLetter } from "../chat/autoRoute";

// Three missed polls: the server is connected but no longer answering.
const STALE_AFTER_MS = 90_000;

export interface MachineChip {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /** The host name, or the environment's label while nothing is known. */
  readonly name: string;
  readonly status: MachineStatus | null;
  readonly capacity: MachineCapacity | null;
  /** No status yet because the first answer is on its way, not because the machine is off. */
  readonly loading: boolean;
}

/** One chip per machine: environments that reach the same host share the first one's chip. */
export function machineChips(
  environments: ReadonlyArray<MachineEnvironment>,
  now: number,
): MachineChip[] {
  const chips: MachineChip[] = [];
  const hosts = new Set<string>();
  for (const { environmentId, label, status: reported, receivedAt, loading } of environments) {
    const status = reported !== null && now - receivedAt <= STALE_AFTER_MS ? reported : null;
    const key = status === null ? `environment:${environmentId}` : status.hostname.toLowerCase();
    if (hosts.has(key)) continue;
    hosts.add(key);
    chips.push({
      key,
      environmentId,
      environmentLabel: label,
      name: status?.hostname ?? label,
      status,
      capacity: status === null ? null : machineCapacity(status),
      loading: status === null && loading,
    });
  }
  return chips;
}

export interface AccountUsage {
  readonly key: string;
  readonly label: string;
  /** Used percent of the 5-hour window. */
  readonly session: number | null;
  /** Used percent of the weekly window that covers every model. */
  readonly weekly: number | null;
}

/** Claude accounts as the Auto picker names them: "A", and "B" for an instance named "… B". */
export function claudeAccountUsage(accounts: ReadonlyArray<LimitAccount>): AccountUsage[] {
  return accounts
    .filter((account) => account.driver === "claudeAgent")
    .map((account) => {
      const used = (kind: "session" | "weekly") =>
        account.limits.windows.find(
          (window) => window.kind === kind && (window.modelIds?.length ?? 0) === 0,
        )?.usedPercent ?? null;
      return {
        key: account.key,
        label: claudeAccountLetter(account.displayName ?? ""),
        session: used("session"),
        weekly: used("weekly"),
      };
    })
    .toSorted((left, right) => left.label.localeCompare(right.label));
}
