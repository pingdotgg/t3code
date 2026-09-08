/**
 * A module the stress suite MOVES on disk (to `src/api/nested/message.ts`)
 * while `alchemy dev` is running, rewriting the importer in the same burst.
 * The transient state — importer pointing at a path that no longer exists —
 * must fail the rebuild without killing the dev server.
 */
export const message = () => "message-v1";
