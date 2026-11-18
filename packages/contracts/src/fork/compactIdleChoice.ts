import { globalIdleCompaction, IDLE_COMPACTION_MODES, type ServerSettings } from "../settings.ts";

const [onReturn, beforeCacheExpires, off] = IDLE_COMPACTION_MODES;
export const COMPACT_IDLE_CHOICES = [
  onReturn,
  beforeCacheExpires,
  { value: "whenIdle" },
  off,
] as const;
export type CompactIdleChoice = (typeof COMPACT_IDLE_CHOICES)[number]["value"];

/** The environment-wide choice in Settings > Providers > Advanced > Compact idle threads. */
export const compactIdleChoice = (
  settings: Pick<ServerSettings, "compactIdleThreads" | "idleCompaction" | "compactWhenIdle">,
): CompactIdleChoice => {
  const mode = globalIdleCompaction(settings);
  return mode === "beforeCacheExpires" && settings.compactWhenIdle ? "whenIdle" : mode;
};

export const compactIdleChoicePatch = (choice: CompactIdleChoice) =>
  choice === "whenIdle"
    ? { idleCompaction: "beforeCacheExpires" as const, compactWhenIdle: true }
    : { idleCompaction: choice, compactWhenIdle: false };
