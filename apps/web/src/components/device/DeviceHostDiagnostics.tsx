import type { DeviceServiceState } from "@t3tools/contracts";

/** Ready hosts can report discovery warnings without losing their usable devices. */
export function DeviceHostDiagnostics({
  hosts,
  hostStatuses,
}: {
  hosts: ReadonlyArray<Pick<DeviceServiceState["hosts"][number], "id" | "label">>;
  hostStatuses: DeviceServiceState["hostStatuses"];
}) {
  const diagnostics = hosts.flatMap((host) => {
    const status = hostStatuses[host.id];
    return status?.status === "ready" && status.detail
      ? [{ id: host.id, label: host.label, detail: status.detail }]
      : [];
  });
  if (diagnostics.length === 0) return null;
  return (
    <div role="status" className="space-y-1 text-xs text-muted-foreground">
      {diagnostics.map(({ id, label, detail }) => (
        <p key={id} className="whitespace-pre-line break-words">
          {label}: {detail}
        </p>
      ))}
    </div>
  );
}
