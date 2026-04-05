/**
 * ChatContent — Route-independent chat renderer.
 *
 * Re-exports ChatView so the canvas can render thread content
 * without depending on TanStack Router route params.
 *
 * ChatView already accepts only `threadId` as a prop and fetches
 * all other data from Zustand stores, so no additional wrapping
 * is needed.
 */
export { default as ChatContent } from "./ChatView";
