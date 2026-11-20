import type {
  ServerLifecycleStreamReadyEvent,
  ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type UpdateStage = "downloading" | "installing" | "resuming";

export interface UpdateOutcome {
  readonly status: "committed" | "rolled-back" | "failed";
  /** The release the engine runs after the update settled. */
  readonly version: string;
  readonly reason?: string;
}

export type EngineUpdateState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly stage: UpdateStage; readonly targetVersion: string }
  | { readonly status: "failed"; readonly targetVersion: string; readonly message: string }
  | { readonly status: "finished"; readonly outcome: UpdateOutcome };

export const PendingUpdate = Schema.Struct({
  fromVersion: Schema.String,
  targetVersion: Schema.String,
  /** Named by the launcher when it accepts the update; absent for a server too old to name one. */
  updateId: Schema.optional(Schema.String),
  /** `ready.at` of the process that accepted the update, so a replay of its ready is not the restart. */
  acceptedAt: Schema.optional(Schema.String),
  startedAt: Schema.Number,
});
export type PendingUpdate = typeof PendingUpdate.Type;

/**
 * What a `ready` event says about a pending update, or null while the event is not the restart's.
 * The id is the only way to tell a commit from a rollback: both reconnect.
 */
export function resolveUpdateOutcome(
  pending: PendingUpdate,
  ready: ServerLifecycleStreamReadyEvent,
): UpdateOutcome | null {
  const running = ready.payload.environment.serverVersion;
  if (pending.updateId === undefined) {
    return running === pending.targetVersion ? { status: "committed", version: running } : null;
  }
  const reported = ready.payload.updateOutcome;
  if (reported?.id === pending.updateId) {
    if (reported.status === "committed" && running === pending.targetVersion) {
      return { status: "committed", version: running };
    }
    return {
      status: reported.status === "committed" ? "failed" : reported.status,
      version: running,
      reason:
        reported.reason ??
        (reported.status === "committed"
          ? `The engine runs ${running}, not ${pending.targetVersion}.`
          : `The update ${reported.status}.`),
    };
  }
  if (pending.acceptedAt !== undefined && ready.payload.at !== pending.acceptedAt) {
    return {
      status: "failed",
      version: running,
      reason: "The service restarted without reporting the update.",
    };
  }
  return null;
}

/** An engine the app reached through `AGENT_BOARD_ENGINE_URL` belongs to someone else's service. */
export const canUpdateEngine = (
  source: "service" | "url",
  capability: ServerSelfUpdateCapability | undefined,
): boolean => source === "service" && (capability === "boot-service" || capability === "respawn");

const parseRelease = (text: string) => /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number);

/** The release to offer, when it is newer than the running one. */
export function offeredRelease(version: string | null, latest: string | null): string | null {
  const have = version === null ? undefined : parseRelease(version);
  const want = latest === null ? undefined : parseRelease(latest);
  if (latest === null || have === undefined || want === undefined) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (want[index] ?? 0) - (have[index] ?? 0);
    if (difference !== 0) return difference > 0 ? latest : null;
  }
  return null;
}
