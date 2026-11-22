import {
  SANDBOX_PROVIDER_KINDS,
  type CloudSandboxRecord,
  type SandboxProviderAvailability,
  type SandboxProviderKind,
  type SandboxSpawnInput,
  type SandboxState,
} from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

interface SandboxProviderMeta {
  readonly kind: SandboxProviderKind;
  readonly label: string;
  readonly freeTierHint: string;
}

export const SANDBOX_PROVIDER_META: Readonly<Record<SandboxProviderKind, SandboxProviderMeta>> = {
  codesandbox: {
    kind: "codesandbox",
    label: msg("CodeSandbox"),
    freeTierHint: msg("400 VM credits/mo (~40h Nano)"),
  },
  "upstash-box": {
    kind: "upstash-box",
    label: msg("Upstash Box"),
    freeTierHint: msg("5 Active CPU hrs/mo, auto-pause"),
  },
  "vercel-sandbox": {
    kind: "vercel-sandbox",
    label: msg("Vercel Sandbox"),
    freeTierHint: msg("5 Active CPU hrs/mo, 45m max continuous w/ auto-snapshot"),
  },
};

interface SandboxAgentHarnessOption {
  readonly value: string;
  readonly label: string;
}

export const SANDBOX_AGENT_HARNESS_OPTIONS: ReadonlyArray<SandboxAgentHarnessOption> = [
  { value: "primeAgent", label: msg("Prime Agent") },
  { value: "claude", label: msg("Claude Code") },
  { value: "codex", label: msg("Codex") },
  { value: "opencode", label: msg("OpenCode") },
];

export type MobileSandboxBadgeTone = "info" | "success" | "muted" | "warning" | "danger";

interface SandboxStatusBadgeInfo {
  readonly label: string;
  readonly tone: MobileSandboxBadgeTone;
}

export function resolveSandboxStatusBadge(
  state: SandboxState,
  resolve: MessageResolver = m,
): SandboxStatusBadgeInfo {
  switch (state) {
    case "creating":
    case "bootstrapping":
      return { label: resolve(msg("Booting")), tone: "info" };
    case "running":
      return { label: resolve(msg("Ready")), tone: "success" };
    case "paused":
    case "stopped":
      return { label: resolve(msg("Sleeping")), tone: "muted" };
    case "snapshotting":
      return { label: resolve(msg("Snapshotting")), tone: "warning" };
    case "destroying":
      return { label: resolve(msg("Destroying")), tone: "muted" };
    case "error":
      return { label: resolve(msg("Error")), tone: "danger" };
  }
}

export function formatSandboxAgentHarness(
  harness: string | null,
  resolve: MessageResolver = m,
): string | null {
  if (!harness) return null;
  const normalized = harness.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const match = SANDBOX_AGENT_HARNESS_OPTIONS.find(
    (option) => option.value.toLowerCase() === normalized,
  );
  if (match) return resolve(match.label);
  if (normalized === "claude-code") return resolve(msg("Claude Code"));
  return harness.trim();
}

export function resolveDefaultSandboxProvider(
  providers: ReadonlyArray<SandboxProviderAvailability>,
): SandboxProviderKind {
  const configured = providers.find((entry) => entry.configured);
  if (configured) return configured.provider;
  return SANDBOX_PROVIDER_KINDS[0];
}

export function getSandboxProviderAvailability(
  providers: ReadonlyArray<SandboxProviderAvailability>,
  kind: SandboxProviderKind,
): SandboxProviderAvailability {
  return (
    providers.find((entry) => entry.provider === kind) ?? {
      provider: kind,
      configured: false,
      defaultSnapshotId: null,
    }
  );
}

const ACTIVE_RUNTIME_STATES: ReadonlySet<SandboxState> = new Set([
  "creating",
  "bootstrapping",
  "running",
  "snapshotting",
]);

const VERCEL_WARN_MINUTES = 40;

function parseTimestampMs(iso: string | null): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeSandboxRuntimeMs(
  sandbox: Pick<CloudSandboxRecord, "state" | "startedAt" | "pausedAt">,
  nowMs: number,
): number | null {
  const startedMs = parseTimestampMs(sandbox.startedAt);
  if (startedMs === null) return null;

  if (ACTIVE_RUNTIME_STATES.has(sandbox.state)) {
    return Math.max(0, nowMs - startedMs);
  }

  const pausedMs = parseTimestampMs(sandbox.pausedAt);
  if (pausedMs !== null && pausedMs >= startedMs) {
    return pausedMs - startedMs;
  }

  return null;
}

export function formatSandboxRuntimeDuration(
  sandbox: Pick<CloudSandboxRecord, "state" | "startedAt" | "pausedAt">,
  nowMs: number,
): string | null {
  const elapsedMs = computeSandboxRuntimeMs(sandbox, nowMs);
  if (elapsedMs === null) return null;

  const totalMinutes = Math.floor(elapsedMs / 60_000);
  if (totalMinutes < 1) return "<1m";
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function isVercelRuntimeWarningActive(
  sandbox: Pick<
    CloudSandboxRecord,
    "provider" | "state" | "startedAt" | "pausedAt" | "vercelWarnedAt"
  >,
  nowMs: number,
): boolean {
  if (sandbox.provider !== "vercel-sandbox") return false;
  if (!ACTIVE_RUNTIME_STATES.has(sandbox.state)) return false;
  if (sandbox.vercelWarnedAt !== null) return true;
  const elapsedMs = computeSandboxRuntimeMs(sandbox, nowMs);
  return elapsedMs !== null && elapsedMs >= VERCEL_WARN_MINUTES * 60_000;
}

interface SandboxRowActions {
  readonly canWake: boolean;
  readonly canSnapshot: boolean;
  readonly canSleep: boolean;
  readonly canDestroy: boolean;
}

export function resolveSandboxRowActions(state: SandboxState, busy: boolean): SandboxRowActions {
  return {
    canWake: !busy && (state === "paused" || state === "stopped" || state === "error"),
    canSnapshot: !busy && (state === "running" || state === "paused" || state === "stopped"),
    canSleep: !busy && (state === "running" || state === "bootstrapping"),
    canDestroy: !busy && state !== "destroying",
  };
}

const STATE_SORT_ORDER: Readonly<Record<SandboxState, number>> = {
  running: 0,
  bootstrapping: 1,
  creating: 2,
  snapshotting: 3,
  paused: 4,
  stopped: 5,
  error: 6,
  destroying: 7,
};

export function sortCloudSandboxes(
  sandboxes: ReadonlyArray<CloudSandboxRecord>,
): ReadonlyArray<CloudSandboxRecord> {
  return [...sandboxes].sort((left, right) => {
    const orderDiff = STATE_SORT_ORDER[left.state] - STATE_SORT_ORDER[right.state];
    if (orderDiff !== 0) return orderDiff;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

interface SandboxSpawnFormDraft {
  readonly provider: SandboxProviderKind;
  readonly name: string;
  readonly repoUrl: string;
  readonly branch: string;
  readonly agentHarness: string;
  readonly snapshotId: string;
  readonly idleTimeoutMinutes: string;
}

type BuildSandboxSpawnResult =
  | { readonly ok: true; readonly input: SandboxSpawnInput }
  | { readonly ok: false; readonly error: string };

const REPO_URL_PATTERN = /^(?:https?:\/\/|ssh:\/\/|git@)[^\s]+$/u;

export function buildSandboxSpawnInput(
  draft: SandboxSpawnFormDraft,
  options: {
    readonly providers: ReadonlyArray<SandboxProviderAvailability>;
    readonly defaultIdleTimeoutMinutes: number;
  },
  resolve: MessageResolver = m,
): BuildSandboxSpawnResult {
  const availability = options.providers.find((entry) => entry.provider === draft.provider);
  if (availability && !availability.configured) {
    return {
      ok: false,
      error:
        availability.reason ??
        resolve(
          msg("{provider} is not configured on this server.", {
            provider: resolve(SANDBOX_PROVIDER_META[draft.provider].label),
          }),
        ),
    };
  }

  const trimmedRepoUrl = draft.repoUrl.trim();
  if (trimmedRepoUrl.length > 0 && !REPO_URL_PATTERN.test(trimmedRepoUrl)) {
    return {
      ok: false,
      error: resolve(msg("Enter a valid repository URL (https://, ssh://, or git@).")),
    };
  }

  const trimmedIdle = draft.idleTimeoutMinutes.trim();
  let idleTimeoutMinutes = options.defaultIdleTimeoutMinutes;
  if (trimmedIdle.length > 0) {
    if (!/^\d+$/u.test(trimmedIdle)) {
      return {
        ok: false,
        error: resolve(msg("Auto-hibernate idle timeout must be between 1 and 1440 minutes.")),
      };
    }
    const parsedIdle = Number.parseInt(trimmedIdle, 10);
    if (!Number.isInteger(parsedIdle) || parsedIdle < 1 || parsedIdle > 1440) {
      return {
        ok: false,
        error: resolve(msg("Auto-hibernate idle timeout must be between 1 and 1440 minutes.")),
      };
    }
    idleTimeoutMinutes = parsedIdle;
  }

  const name = draft.name.trim();
  const branch = draft.branch.trim();
  const agentHarness = draft.agentHarness.trim();
  const snapshotId = draft.snapshotId.trim();

  return {
    ok: true,
    input: {
      provider: draft.provider,
      ...(name.length > 0 ? { name } : {}),
      ...(trimmedRepoUrl.length > 0 ? { repoUrl: trimmedRepoUrl } : {}),
      ...(branch.length > 0 ? { branch } : {}),
      ...(agentHarness.length > 0 ? { agentHarness } : {}),
      ...(snapshotId.length > 0 ? { snapshotId } : {}),
      idleTimeoutMinutes,
    },
  };
}
