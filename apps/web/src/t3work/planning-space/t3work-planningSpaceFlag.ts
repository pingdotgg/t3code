/**
 * Feature gate for the planning space view mode (spec §2): enabled in dev
 * builds by default, opt-in elsewhere via VITE_PLANNING_SPACE=1. Removed in
 * delivery phase P5 together with the legacy view modes.
 */
export const planningSpaceEnabled: boolean =
  import.meta.env.DEV || import.meta.env["VITE_PLANNING_SPACE"] === "1";
