import { threadAutoSettlePolicy } from "@t3tools/client-runtime/state/thread-settled";
import {
  DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ClientSettings,
  type ClientSettingsPatch,
  type ThreadAutoSettleMode,
} from "@t3tools/contracts/settings";

type StoredThreadAutoSettleSettings = Pick<
  ClientSettings,
  "sidebarAutoSettleAfterDays" | "sidebarAutoSettleOnPullRequestCompletion"
>;

export function resolveClientThreadAutoSettleMode(
  settings: StoredThreadAutoSettleSettings,
): ThreadAutoSettleMode {
  if (settings.sidebarAutoSettleAfterDays === null) {
    return settings.sidebarAutoSettleOnPullRequestCompletion ? "pull-request" : "never";
  }
  return settings.sidebarAutoSettleOnPullRequestCompletion
    ? "inactive-or-pull-request"
    : "inactive";
}

export function resolveClientThreadAutoSettlePolicy(settings: StoredThreadAutoSettleSettings) {
  return threadAutoSettlePolicy({
    mode: resolveClientThreadAutoSettleMode(settings),
    afterDays: settings.sidebarAutoSettleAfterDays ?? DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  });
}

export function clientThreadAutoSettlePatchForMode(input: {
  readonly mode: ThreadAutoSettleMode;
  readonly currentAfterDays: number | null;
}): Pick<
  ClientSettingsPatch,
  "sidebarAutoSettleAfterDays" | "sidebarAutoSettleOnPullRequestCompletion"
> {
  const includesInactivity = input.mode === "inactive" || input.mode === "inactive-or-pull-request";
  return {
    sidebarAutoSettleAfterDays: includesInactivity
      ? (input.currentAfterDays ?? DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS)
      : null,
    sidebarAutoSettleOnPullRequestCompletion:
      input.mode === "pull-request" || input.mode === "inactive-or-pull-request",
  };
}
