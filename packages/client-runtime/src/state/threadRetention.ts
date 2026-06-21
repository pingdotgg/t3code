// Mobile thread routes unmount during back navigation. Retain the stream-backed
// state across short subscriber gaps without keeping every opened thread alive.
export const THREAD_STATE_IDLE_TTL_MS = 5 * 60_000;
