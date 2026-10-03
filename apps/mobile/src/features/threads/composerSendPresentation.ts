import {
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
  type ActiveTurnComposerAction,
} from "@t3tools/client-runtime/state/composer-dispatch";

import type { FollowUpBehavior } from "../../lib/followUpBehavior";

export interface ComposerSendPresentation {
  readonly label: string;
  readonly icon: "arrow.up" | "checkmark" | "list.number" | "arrow.turn.left.up";
  /** What a plain tap does while a turn runs, or null when the turn is idle. */
  readonly action: ActiveTurnComposerAction | null;
  /** What the long-press menu and the Command chord do instead. */
  readonly alternate: ActiveTurnComposerAction | null;
  /** The follow-up menu is meaningless outside a running turn or during an edit. */
  readonly offersFollowUpChoice: boolean;
}

const ACTION_LABEL: Record<ActiveTurnComposerAction, string> = {
  queue: "Queue",
  steer: "Steer",
  restart: "Restart",
};

/**
 * What the composer's primary button says and does. Steering is only offered
 * when the provider can actually steer the live turn, so the button never
 * promises something the server would have to silently downgrade.
 */
export function resolveComposerSendPresentation(input: {
  readonly editingQueuedMessage: boolean;
  readonly running: boolean;
  readonly canSteer: boolean;
  readonly followUpBehavior: FollowUpBehavior;
  /** Outbox reasons the send waits rather than leaving immediately. */
  readonly deliveryDeferred: boolean;
}): ComposerSendPresentation {
  if (input.editingQueuedMessage) {
    return {
      label: "Update queued message",
      icon: "checkmark",
      action: null,
      alternate: null,
      offersFollowUpChoice: false,
    };
  }
  if (!input.running) {
    return {
      label: input.deliveryDeferred ? "Queue" : "Send",
      icon: "arrow.up",
      action: null,
      alternate: null,
      offersFollowUpChoice: false,
    };
  }
  // Without steering support the choice collapses: every follow-up queues, so
  // offering a menu with one usable entry would be noise.
  const action: ActiveTurnComposerAction = input.canSteer ? input.followUpBehavior : "queue";
  const alternate = alternateComposerDispatchAction(action);
  return {
    label: ACTION_LABEL[action],
    icon: action === "steer" ? "arrow.turn.left.up" : "list.number",
    action,
    alternate: input.canSteer ? alternate : null,
    offersFollowUpChoice: input.canSteer,
  };
}

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
