/**
 * Re-runs the idempotent cold-archive migration for databases that recorded
 * upstream's title-regeneration migration under ID 35 before switching to this
 * branch.
 */
export { default } from "./035_ThreadColdArchive.ts";
