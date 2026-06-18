import * as Duration from "effect/Duration";

// Startup cleanup only; live VS Code backend bearer tokens use the normal session TTL.
export const DESKTOP_BOOTSTRAP_BEARER_SESSION_STALE_AGE = Duration.hours(12);
