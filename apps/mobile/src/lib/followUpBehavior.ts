import {
  resolveComposerDispatchMode,
  type ActiveTurnComposerAction,
} from "@t3tools/client-runtime/state/composer-dispatch";

/**
 * What the send button does while a turn is already running: `queue` waits for
 * the turn to finish, `steer` interrupts it with the new message.
 *
 * Web keeps the same choice in its per-client settings. Mobile has no
 * client-settings sync, so it is stored per device alongside the other
 * composer preferences.
 */
export type FollowUpBehavior = Extract<ActiveTurnComposerAction, "queue" | "steer">;

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "queue";

/**
 * The outbox dispatch mode for a send, or null when the thread is idle and the
 * server decides. Steering travels as "auto" so a turn that ends before the
 * outbox delivers degrades to a queued run instead of failing the delivery and
 * bouncing the message back into the draft.
 */
export function resolveFollowUpDispatchMode(input: {
  readonly running: boolean;
  readonly canSteer: boolean;
  readonly isCompacting: boolean;
  readonly followUpBehavior: FollowUpBehavior;
  readonly followUpOverride?: ActiveTurnComposerAction;
}): "queue" | "auto" | null {
  const action = resolveComposerDispatchMode({
    // Compaction queues explicitly: while /compact is still being dispatched
    // the active run is the ordinary one, which an auto send would steer.
    running: input.running && (input.canSteer || input.isCompacting),
    alternateModifier:
      input.followUpOverride !== undefined && input.followUpOverride !== input.followUpBehavior,
    activeTurnDefault: input.followUpBehavior,
    activeTurnIsCompaction: input.isCompacting,
  });
  return action === "auto" ? null : action === "queue" ? "queue" : "auto";
}
