import type {
  FederationPeerCodePayload,
  FederationPeerStatus,
  FederationRemoteRun,
  FederationRunStatus,
  FederationScope,
} from "@t3tools/contracts";
import {
  T3ConnectionCodeInvalidError,
  decodeFederationPeerCode,
  isT3ConnectionCode,
  peekT3ConnectionCodeKind,
} from "@t3tools/shared/t3ConnectionCode";
import * as Schema from "effect/Schema";

const isCodeInvalidError = Schema.is(T3ConnectionCodeInvalidError);

export const FEDERATION_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: FederationScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: "environment.read",
    title: "See environment",
    description: "Read this environment's name, version, and capabilities.",
  },
  {
    scope: "projects.read",
    title: "List projects",
    description: "See which projects can be targeted for a run.",
  },
  {
    scope: "runs.read",
    title: "Follow runs",
    description: "Read status and event summaries of runs it started here.",
  },
  {
    scope: "runs.start",
    title: "Start runs",
    description: "Start agent runs in this environment's projects.",
  },
  {
    scope: "runs.cancel",
    title: "Cancel runs",
    description: "Interrupt runs it started here.",
  },
  {
    scope: "artifacts.read",
    title: "Read changes",
    description: "Fetch the diffs produced by runs it started here.",
  },
];

export function toggleFederationScope(
  scopes: ReadonlyArray<FederationScope>,
  scope: FederationScope,
  checked: boolean,
): ReadonlyArray<FederationScope> {
  if (checked) {
    return scopes.includes(scope) ? scopes : [...scopes, scope];
  }
  return scopes.filter((candidate) => candidate !== scope);
}

export type RemoteRunBadgeVariant = "outline" | "warning" | "success" | "error" | "info";

export function remoteRunStatusLabel(status: FederationRunStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "error":
      return "Failed";
  }
}

export function remoteRunStatusBadgeVariant(status: FederationRunStatus): RemoteRunBadgeVariant {
  switch (status) {
    case "queued":
      return "info";
    case "running":
      return "warning";
    case "completed":
      return "success";
    case "interrupted":
      return "outline";
    case "error":
      return "error";
  }
}

/** Queued and running runs can still be cancelled on the peer. */
export function isRemoteRunActive(status: FederationRunStatus): boolean {
  return status === "queued" || status === "running";
}

/** The freshest one-line description of a remote run: its latest event, else the assistant preview. */
export function remoteRunLastEventSummary(remoteRun: FederationRemoteRun): string | null {
  const latest = remoteRun.events.reduce<FederationRemoteRun["events"][number] | null>(
    (best, event) => (best === null || event.sequence > best.sequence ? event : best),
    null,
  );
  const summary = latest?.summary.trim();
  if (summary) return summary;
  const preview = remoteRun.run.assistantPreview?.trim();
  return preview ? preview : null;
}

/** Newest request first, so the run just started is at the top. */
export function sortRemoteRuns(
  runs: ReadonlyArray<FederationRemoteRun>,
): ReadonlyArray<FederationRemoteRun> {
  return [...runs].toSorted(
    (left, right) => Date.parse(right.run.requestedAt) - Date.parse(left.run.requestedAt),
  );
}

export function peerStatusDotClassName(status: FederationPeerStatus): string {
  switch (status) {
    case "online":
      return "bg-success";
    case "offline":
      return "bg-destructive";
    case "unknown":
      return "bg-muted-foreground/40";
  }
}

export function peerStatusLabel(status: FederationPeerStatus): string {
  switch (status) {
    case "online":
      return "Online";
    case "offline":
      return "Offline";
    case "unknown":
      return "Not checked yet";
  }
}

export type FederationPeerCodePreview =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "tailcat-code"; readonly message: string }
  | {
      readonly kind: "valid";
      readonly payload: FederationPeerCodePayload;
      readonly expired: boolean;
    };

/** Live feedback for the peer-code field; a Tailcat connection code is redirected, not rejected. */
export function describeFederationPeerCode(raw: string, nowMs: number): FederationPeerCodePreview {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }
  if (!isT3ConnectionCode(trimmed)) {
    return { kind: "invalid", message: "Paste the full peer code. It starts with t3c://peer/." };
  }
  if (peekT3ConnectionCodeKind(trimmed) === "tailcat") {
    return {
      kind: "tailcat-code",
      message:
        "This is a Tailcat connection code for a device. Use Add environment → Tailcat instead.",
    };
  }
  try {
    const payload = decodeFederationPeerCode(trimmed);
    return { kind: "valid", payload, expired: Date.parse(payload.expiresAt) <= nowMs };
  } catch (cause) {
    return {
      kind: "invalid",
      message: isCodeInvalidError(cause) ? cause.message : "This peer code could not be read.",
    };
  }
}

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatFederationTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : timestampFormatter.format(parsed);
}
