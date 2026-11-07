import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  SecretDeliveryInput,
} from "@t3tools/contracts";

import * as Schema from "effect/Schema";

import { secretFailureMessage } from "./secretRequest.ts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./state/runtime.ts";

export type SecretDeliveryItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "secret_delivery" }
>;

export const SECRET_DELIVERY_PRIVACY_NOTE = "Kept out of chat, available for 24 hours";

export type SecretDeliveryUnavailableReason = "deleted" | "expired" | "elsewhere" | "private";

export type SecretDeliveryDisplay =
  | { readonly kind: "available" }
  | {
      readonly kind: "unavailable";
      readonly reason: SecretDeliveryUnavailableReason;
      readonly label: string;
    };

const AVAILABLE: SecretDeliveryDisplay = { kind: "available" };
const DELETED: SecretDeliveryDisplay = { kind: "unavailable", reason: "deleted", label: "Deleted" };
const EXPIRED: SecretDeliveryDisplay = { kind: "unavailable", reason: "expired", label: "Expired" };
const ELSEWHERE: SecretDeliveryDisplay = {
  kind: "unavailable",
  reason: "elsewhere",
  label: "Available in the original thread",
};
const PRIVATE: SecretDeliveryDisplay = {
  kind: "unavailable",
  reason: "private",
  label: "Kept private",
};

/**
 * `deadlinePassed` comes from the client clock, so the card expires before the server's
 * status event arrives. Only the original thread, with operate access, retrieves the value:
 * an inherited (forked) copy or a guest view shows metadata alone.
 */
export function secretDeliveryDisplay(
  item: Pick<SecretDeliveryItem, "secretStatus">,
  context: {
    readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
    readonly deadlinePassed: boolean;
    readonly canRetrieve: boolean;
  },
): SecretDeliveryDisplay {
  if (item.secretStatus === "deleted") return DELETED;
  if (item.secretStatus === "expired" || context.deadlinePassed) return EXPIRED;
  if (context.visibility !== "local") return ELSEWHERE;
  return context.canRetrieve ? AVAILABLE : PRIVATE;
}

export function secretDeliveryInput(
  item: Pick<SecretDeliveryItem, "id" | "threadId">,
): SecretDeliveryInput {
  return { threadId: item.threadId, deliveryId: item.id };
}

type SecretDeliveryAction = "reveal" | "copy" | "delete";

interface SecretDeliveryRevealState {
  /** Shown on screen only while revealed. */
  readonly value: string | null;
  readonly pending: SecretDeliveryAction | null;
  readonly copied: boolean;
  readonly deleted: boolean;
  readonly error: string | null;
}

const IDLE: SecretDeliveryRevealState = {
  value: null,
  pending: null,
  copied: false,
  deleted: false,
  error: null,
};

/** Rejects a clipboard write whose read failed or was superseded, so nothing reaches the clipboard. */
class SecretDeliveryReadSkipped extends Schema.TaggedError<SecretDeliveryReadSkipped>()(
  "SecretDeliveryReadSkipped",
  {},
) {}

const failureMessage = (result: AtomCommandResult<unknown, unknown>, fallback: string) =>
  result._tag === "Failure" && !isAtomCommandInterrupted(result)
    ? secretFailureMessage(squashAtomCommandFailure(result), fallback)
    : null;

const READ_FALLBACK = "Could not read the secret. Try again.";

/**
 * One card's transient reveal state, owned by that card and dropped with it.
 * Hide, navigation, backgrounding and unmount all start a new generation, so a
 * read or copy that settles afterwards is ignored and never shows or copies the value.
 * Subscribe with `useSyncExternalStore`.
 */
export function createSecretDeliveryReveal(operations: {
  readonly read: () => Promise<AtomCommandResult<{ readonly value: string }, unknown>>;
  readonly delete: () => Promise<AtomCommandResult<void, unknown>>;
}) {
  let state = IDLE;
  let generation = 0;
  const listeners = new Set<() => void>();
  const set = (next: SecretDeliveryRevealState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const begin = (action: SecretDeliveryAction) => {
    if (state.pending !== null || state.deleted) return null;
    generation += 1;
    set({ ...state, pending: action, copied: false, error: null });
    return generation;
  };
  const settle = (token: number, next: Partial<SecretDeliveryRevealState>) => {
    if (token === generation) set({ ...state, pending: null, ...next });
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,

    reveal: async () => {
      const token = begin("reveal");
      if (token === null) return;
      const result = await operations.read();
      settle(
        token,
        result._tag === "Success"
          ? { value: result.value.value }
          : { error: failureMessage(result, READ_FALLBACK) },
      );
    },

    /**
     * `write` receives the value as a promise so a browser can start its clipboard write inside
     * the click. The promise rejects when the read fails or is superseded.
     */
    copy: async (write: (value: Promise<string>) => Promise<boolean>) => {
      const token = begin("copy");
      if (token === null) return;
      let readError: string | null = null;
      const value = operations.read().then((result) => {
        if (token !== generation) throw new SecretDeliveryReadSkipped();
        if (result._tag === "Success") return result.value.value;
        readError = failureMessage(result, READ_FALLBACK);
        throw new SecretDeliveryReadSkipped();
      });
      const copied = await write(value).catch(() => false);
      settle(token, {
        copied,
        error: readError ?? (copied ? null : "Could not copy to the clipboard."),
      });
    },

    /** Clears the shown value at once; the item's status event follows the server's deletion. */
    delete: async () => {
      const token = begin("delete");
      if (token === null) return;
      set({ ...state, value: null });
      const result = await operations.delete();
      settle(
        token,
        result._tag === "Success"
          ? { deleted: true }
          : { error: failureMessage(result, "Could not delete the secret. Try again.") },
      );
    },

    /**
     * Hide, navigation, backgrounding and unmount: drops the value and anything in flight.
     * Safe to call from an effect cleanup that StrictMode or `<Activity>` replays.
     */
    hide: () => {
      // A deletion already cleared the value; its result still has to land.
      if (state.pending === "delete") return;
      generation += 1;
      if (state !== IDLE && !state.deleted) set(IDLE);
    },
  };
}
