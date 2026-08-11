import { threadAutoSettlePolicy } from "@t3tools/client-runtime/state/thread-settled";
import {
  DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ClientSettings,
  type ClientSettingsPatch,
  type ThreadAutoSettleMode,
} from "@t3tools/contracts/settings";

type StoredThreadAutoSettleSettings = {
  readonly sidebarAutoSettleAfterDays: ClientSettings["sidebarAutoSettleAfterDays"];
  readonly sidebarAutoSettleMode?: ThreadAutoSettleMode | undefined;
};

export function resolveClientThreadAutoSettleMode(
  settings: StoredThreadAutoSettleSettings,
): ThreadAutoSettleMode {
  return (
    settings.sidebarAutoSettleMode ??
    (settings.sidebarAutoSettleAfterDays === null ? "pull-request" : "inactive-or-pull-request")
  );
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
}): Pick<ClientSettingsPatch, "sidebarAutoSettleAfterDays" | "sidebarAutoSettleMode"> {
  const includesInactivity = input.mode === "inactive" || input.mode === "inactive-or-pull-request";
  return {
    sidebarAutoSettleMode: input.mode,
    ...(includesInactivity && input.currentAfterDays === null
      ? { sidebarAutoSettleAfterDays: DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS }
      : {}),
  };
}
