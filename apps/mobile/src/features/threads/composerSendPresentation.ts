import {
  alternateComposerDispatchAction,
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
