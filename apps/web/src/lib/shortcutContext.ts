import type { ShortcutMatchContext } from "../keybindings";

type ShortcutContextReader = () => ShortcutMatchContext;

let published: ShortcutContextReader | null = null;

/**
 * Publishes the keydown dispatcher's live `when` context. The mounted
 * ChatView owns the dispatcher, so it publishes; host-local resolvers read
 * it to evaluate rules against exactly what the dispatcher sees. Returns
 * the unpublish, which only clears its own reader.
 */
export function publishShortcutContext(reader: ShortcutContextReader): () => void {
  published = reader;
  return () => {
    if (published === reader) published = null;
  };
}

/** The dispatcher's current context; empty when no dispatcher is mounted. */
export function readShortcutContext(): Partial<ShortcutMatchContext> {
  return published?.() ?? {};
}
