import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * A ballot is an inline page (html_render) where the reader marks choices; its Done button calls
 * `t3Compose(text)` to hand the picks to the open chat's message box. The page lives in the
 * timeline, far from the composer, so the chat view listens here and accepts only picks from
 * ballots in the thread it shows. Nothing is sent.
 */
export interface BallotPicksRequest {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly text: string;
}

type Listener = (request: BallotPicksRequest) => boolean;

const listeners = new Set<Listener>();

export function onBallotPicks(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when a chat view took the text. */
export function requestBallotPicks(request: BallotPicksRequest): boolean {
  for (const listener of listeners) {
    if (listener(request)) return true;
  }
  return false;
}
