/**
 * How this window gets to a thread another machine started. The source server reaches that
 * machine through its own peer link, which this window cannot use, so the window opens the
 * thread only through a connection of its own.
 */
export type ContinuedThreadFollowThrough =
  /** This window has the machine on: open the thread once it arrives. */
  | { readonly kind: "open" }
  /** This window has the machine saved but switched off. */
  | { readonly kind: "turn-on" }
  /** This window does not know the machine: pair with it at the address the link uses. */
  | { readonly kind: "connect"; readonly host: string | null };

export function continuedThreadFollowThrough(input: {
  /** This window's saved connection to the machine, if any. */
  readonly saved: { readonly enabled: boolean } | null;
  /** The addresses the source server linked the machine at. */
  readonly linkUrls: ReadonlyArray<string>;
}): ContinuedThreadFollowThrough {
  if (input.saved === null) return { kind: "connect", host: input.linkUrls[0] ?? null };
  return input.saved.enabled ? { kind: "open" } : { kind: "turn-on" };
}
