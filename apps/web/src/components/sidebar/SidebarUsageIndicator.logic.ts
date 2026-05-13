import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";

import {
  deriveLatestContextWindowSnapshot,
  type ContextWindowSnapshot,
} from "../../lib/contextWindow";

export type SidebarUsageDriverId = "codex" | "claudeAgent";

export interface SidebarUsageProviderInstanceInput {
  readonly instanceId: ProviderInstanceId | string;
  readonly driverKind: ProviderDriverKind | string;
}

export interface SidebarUsageThreadInput {
  readonly id: string;
  readonly title: string;
  readonly modelSelectionInstanceId: ProviderInstanceId | string;
  readonly sessionProvider?: ProviderDriverKind | string | null | undefined;
  readonly sessionProviderInstanceId?: ProviderInstanceId | string | null | undefined;
  readonly activities: Parameters<typeof deriveLatestContextWindowSnapshot>[0];
}

export interface SidebarUsageProviderRow {
  readonly driverId: SidebarUsageDriverId;
  readonly driverKind: ProviderDriverKind;
  readonly label: string;
  readonly usage: ContextWindowSnapshot | null;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
}

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

export const SIDEBAR_USAGE_PROVIDER_ROWS: ReadonlyArray<{
  readonly driverId: SidebarUsageDriverId;
  readonly driverKind: ProviderDriverKind;
  readonly label: string;
}> = [
  {
    driverId: "codex",
    driverKind: CODEX_DRIVER_KIND,
    label: "Codex",
  },
  {
    driverId: "claudeAgent",
    driverKind: CLAUDE_DRIVER_KIND,
    label: "Claude",
  },
];

function isSidebarUsageDriverId(value: string | null | undefined): value is SidebarUsageDriverId {
  return value === "codex" || value === "claudeAgent";
}

function resolveThreadDriverId(
  thread: SidebarUsageThreadInput,
  driverIdByInstanceId: ReadonlyMap<string, SidebarUsageDriverId>,
): SidebarUsageDriverId | null {
  const sessionInstanceDriver = thread.sessionProviderInstanceId
    ? driverIdByInstanceId.get(String(thread.sessionProviderInstanceId))
    : undefined;
  if (sessionInstanceDriver) {
    return sessionInstanceDriver;
  }

  const modelInstanceDriver = driverIdByInstanceId.get(String(thread.modelSelectionInstanceId));
  if (modelInstanceDriver) {
    return modelInstanceDriver;
  }

  const sessionProvider = thread.sessionProvider ? String(thread.sessionProvider) : null;
  if (isSidebarUsageDriverId(sessionProvider)) {
    return sessionProvider;
  }

  const modelSelectionInstanceId = String(thread.modelSelectionInstanceId);
  return isSidebarUsageDriverId(modelSelectionInstanceId) ? modelSelectionInstanceId : null;
}

function isNewerUsage(
  candidate: ContextWindowSnapshot,
  current: ContextWindowSnapshot | null,
): boolean {
  if (!current) {
    return true;
  }
  return candidate.updatedAt.localeCompare(current.updatedAt) > 0;
}

export function deriveSidebarUsageProviderRows(input: {
  readonly providerInstances: ReadonlyArray<SidebarUsageProviderInstanceInput>;
  readonly threads: ReadonlyArray<SidebarUsageThreadInput>;
}): ReadonlyArray<SidebarUsageProviderRow> {
  const driverIdByInstanceId = new Map<string, SidebarUsageDriverId>();
  for (const instance of input.providerInstances) {
    const driverId = String(instance.driverKind);
    if (isSidebarUsageDriverId(driverId)) {
      driverIdByInstanceId.set(String(instance.instanceId), driverId);
    }
  }

  const latestByDriverId = new Map<
    SidebarUsageDriverId,
    {
      readonly usage: ContextWindowSnapshot;
      readonly threadId: string;
      readonly threadTitle: string;
    }
  >();

  for (const thread of input.threads) {
    const usage = deriveLatestContextWindowSnapshot(thread.activities);
    if (!usage) {
      continue;
    }

    const driverId = resolveThreadDriverId(thread, driverIdByInstanceId);
    if (!driverId) {
      continue;
    }

    const current = latestByDriverId.get(driverId);
    if (current && !isNewerUsage(usage, current.usage)) {
      continue;
    }

    latestByDriverId.set(driverId, {
      usage,
      threadId: thread.id,
      threadTitle: thread.title,
    });
  }

  return SIDEBAR_USAGE_PROVIDER_ROWS.map((row) => {
    const latest = latestByDriverId.get(row.driverId);
    return {
      driverId: row.driverId,
      driverKind: row.driverKind,
      label: row.label,
      usage: latest?.usage ?? null,
      threadId: latest?.threadId ?? null,
      threadTitle: latest?.threadTitle ?? null,
    } satisfies SidebarUsageProviderRow;
  });
}

export function getSidebarUsageSummaryRow(
  rows: ReadonlyArray<SidebarUsageProviderRow>,
): SidebarUsageProviderRow | null {
  return rows.reduce<SidebarUsageProviderRow | null>((latest, row) => {
    if (!row.usage) {
      return latest;
    }
    if (!latest?.usage) {
      return row;
    }
    return row.usage.updatedAt.localeCompare(latest.usage.updatedAt) > 0 ? row : latest;
  }, null);
}
