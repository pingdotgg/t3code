import {
  MANAGED_ENDPOINT_KEY_PATTERN,
  managedEndpointTunnelNamePrefix,
} from "./deploymentConfig.ts";

// Only pull-request stages may be torn down by the cleanup job. Anchoring the
// pattern keeps `prod`, personal `dev_<user>` stages, and `pr-0` out of reach.
const PREVIEW_STAGE_PATTERN = /^pr-[1-9][0-9]*$/u;

export function isPreviewStage(stage: string): boolean {
  return PREVIEW_STAGE_PATTERN.test(stage);
}

// The prefix ends with a dash, so stage `pr-4` never matches tunnels of `pr-42`.
export function isPreviewTunnelName(name: string, stage: string): boolean {
  if (!isPreviewStage(stage)) return false;
  const prefix = managedEndpointTunnelNamePrefix(stage);
  return name.startsWith(prefix) && MANAGED_ENDPOINT_KEY_PATTERN.test(name.slice(prefix.length));
}

// Managed endpoint hostnames are `<stage>-<endpoint key>.<tunnel zone>`.
export function isPreviewTunnelRecordName(
  recordName: string,
  stage: string,
  tunnelZoneName: string,
): boolean {
  if (!isPreviewStage(stage)) return false;
  const name = recordName.toLowerCase();
  const suffix = `.${tunnelZoneName.trim().toLowerCase()}`;
  if (!name.endsWith(suffix)) return false;
  const label = name.slice(0, -suffix.length);
  const labelPrefix = `${stage}-`;
  return (
    label.startsWith(labelPrefix) &&
    MANAGED_ENDPOINT_KEY_PATTERN.test(label.slice(labelPrefix.length))
  );
}

export function tunnelCnameContent(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

export interface SweepTunnel {
  readonly id: string;
  readonly name?: string | null | undefined;
}

export interface SweepRecord {
  readonly id: string;
  readonly name: string;
  readonly content?: string | null | undefined;
}

// Records are matched through the tunnel they point at, not just by name, so a
// record that happens to share the label is never deleted unless it targets one
// of this stage's tunnels.
export function previewSweepTargets(input: {
  readonly stage: string;
  readonly tunnelZoneName: string;
  readonly tunnels: ReadonlyArray<SweepTunnel>;
  readonly records: ReadonlyArray<SweepRecord>;
}): { readonly tunnels: ReadonlyArray<SweepTunnel>; readonly records: ReadonlyArray<SweepRecord> } {
  const tunnels = input.tunnels.filter(
    (tunnel) => tunnel.name != null && isPreviewTunnelName(tunnel.name, input.stage),
  );
  const tunnelContents = new Set(tunnels.map((tunnel) => tunnelCnameContent(tunnel.id)));
  const records = input.records.filter(
    (record) =>
      isPreviewTunnelRecordName(record.name, input.stage, input.tunnelZoneName) &&
      record.content != null &&
      tunnelContents.has(record.content),
  );
  return { tunnels, records };
}
