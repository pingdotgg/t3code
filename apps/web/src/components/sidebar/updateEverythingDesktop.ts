import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { exactUpdateVersion, type UpdateExecutionPlan } from "./updateEverythingPlan";

export function observeDesktopInstallFailure(
  plan: UpdateExecutionPlan | null,
  state: DesktopUpdateState | null,
): UpdateExecutionPlan | null {
  if (plan?.phase !== "awaiting-local" || state?.errorContext !== "install" || !state.message)
    return plan;
  const app = plan.items.find((item) => item.kind === "app");
  const failedVersion = state.downloadedVersion ?? state.availableVersion;
  if (
    !app ||
    failedVersion === null ||
    !exactUpdateVersion(failedVersion, app.targetVersion) ||
    exactUpdateVersion(state.currentVersion, app.targetVersion)
  )
    return plan;
  return {
    ...plan,
    phase: "paused",
    pausedReason: "install-refused",
  };
}

export async function downloadUpdateForPlan(
  bridge: Pick<DesktopBridge, "getUpdateState" | "downloadUpdate" | "onUpdateState">,
  targetVersion: string,
): Promise<boolean> {
  let finish!: (downloaded: boolean) => void;
  const downloaded = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const inspect = (state: DesktopUpdateState) => {
    if (state.downloadedVersion && exactUpdateVersion(state.downloadedVersion, targetVersion))
      finish(true);
    else if (state.status === "error" && state.errorContext === "download") finish(false);
    else if (state.status === "downloaded" && state.downloadedVersion !== null) finish(false);
  };
  const unsubscribe = bridge.onUpdateState(inspect);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const current = await bridge.getUpdateState();
    if (current.downloadedVersion && exactUpdateVersion(current.downloadedVersion, targetVersion))
      return true;
    if (
      current.availableVersion === null ||
      !exactUpdateVersion(current.availableVersion, targetVersion)
    )
      return false;
    const result = await bridge.downloadUpdate();
    if (!result.completed) return false;
    inspect(result.state);
    timer = setTimeout(() => finish(false), 30_000);
    return await downloaded;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
  }
}
