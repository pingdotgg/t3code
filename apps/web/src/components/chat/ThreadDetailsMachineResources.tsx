import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useContext, useEffect } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { serverEnvironment } from "../../state/server";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { UsageRow } from "./ThreadDetailsUsage";

// Fork-only: CPU, RAM, swap and disk of the thread's environment. The server caches a sample for 5 s.
const REFRESH_MS = 5_000;

const toneOf = (percent: number) => (percent >= 90 ? "error" : percent >= 80 ? "warning" : null);

export function ThreadDetailsMachineResources({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const registry = useContext(RegistryContext);
  const query = serverEnvironment.hostResources({ environmentId, input: {} });
  const result = useAtomValue(query);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the host while the section is shown
  useEffect(() => {
    const timer = setInterval(() => registry.refresh(query), REFRESH_MS);
    return () => clearInterval(timer);
  }, [registry, query]);

  if (result._tag !== "Success") return null;
  const host = result.value;

  const capacityRow = (label: string, total?: number | null, free?: number | null) => {
    if (total == null || free == null || total <= 0) return null;
    const used = Math.max(0, total - free);
    const percent = Math.round((used / total) * 100);
    const value = `${formatBytes(used)} / ${formatBytes(total)}`;
    return (
      <UsageRow
        key={label}
        label={label}
        fill={percent}
        tone={toneOf(percent)}
        muted
        value={value}
        ariaValue={gt("{percent}% used", { percent })}
        tooltip={
          <span className="text-foreground">
            {gt("{label}: {percent}% used", { label, percent })}
          </span>
        }
      />
    );
  };

  const cpu = host.cpuUtilization === null ? null : Math.round(host.cpuUtilization * 100);
  return (
    <ThreadDetailsSection
      headingId="thread-details-machine-resources-heading"
      title={gt("Machine resources")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {cpu !== null ? (
          <UsageRow
            label={gt("CPU")}
            fill={cpu}
            tone={toneOf(cpu)}
            muted
            value={`${cpu}%`}
            tooltip={
              <span className="text-foreground">
                {gt("CPU: {percent}% of {count} cores", { percent: cpu, count: host.cpuCount })}
              </span>
            }
          />
        ) : null}
        {capacityRow(
          gt("RAM", { $context: "machine memory row label" }),
          host.totalMemoryBytes,
          host.availableMemoryBytes,
        )}
        {capacityRow(gt("Swap"), host.swapTotalBytes, host.swapFreeBytes)}
        {capacityRow(
          gt("Disk", { $context: "root filesystem row label" }),
          host.diskTotalBytes,
          host.diskFreeBytes,
        )}
      </div>
    </ThreadDetailsSection>
  );
}
