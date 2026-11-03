import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthPreviewOperateScope, type EnvironmentId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { Atom } from "effect/reactivity";

import {
  getClientSettings,
  getClientSettingsHydratedSnapshot,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
} from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { previewEnvironment } from "~/state/preview";
import { environmentSession, sessionHasScope } from "~/state/session";

export interface ProfileReport {
  readonly profiles: ClientSettings["browserProfiles"];
  readonly defaultProfileId: ClientSettings["browserDefaultProfileId"];
  readonly recordingFrameRate: ClientSettings["browserRecordingFrameRate"];
}

/** Server-browser environments this client may operate, with the config each currently runs. */
const reportTargetsAtom = Atom.make((get) => {
  const targets = new Map<EnvironmentId, EnvironmentServerConfig>();
  for (const [environmentId, config] of get(environmentPresentations.serverConfigsAtom)) {
    if (!config.environment.capabilities.serverBrowser) continue;
    const session = get(environmentSession.sessionStateAtom(environmentId));
    if (!sessionHasScope(session, AuthPreviewOperateScope)) continue;
    targets.set(environmentId, config);
  }
  return targets;
}).pipe(Atom.withLabel("browser-profile-report-targets"));

/**
 * Keeps every operable server browser on this client's profiles. An environment is reported
 * again when its server config changes (a restarted server has forgotten them), when it becomes
 * operable, and when the profile settings change.
 */
export function startBrowserProfileReporting(): () => void {
  const reported: ReportedProfiles = new Map();
  const report = () => {
    if (!getClientSettingsHydratedSnapshot()) return;
    const settings = getClientSettings();
    const input: ProfileReport = {
      profiles: settings.browserProfiles,
      defaultProfileId: settings.browserDefaultProfileId,
      recordingFrameRate: settings.browserRecordingFrameRate,
    };
    const targets = appAtomRegistry.get(reportTargetsAtom);
    for (const environmentId of takeDueProfileReports(reported, targets, input)) {
      void runAtomCommand(
        appAtomRegistry,
        previewEnvironment.reportProfiles,
        { environmentId, input },
        { reportFailure: false },
      );
    }
  };
  const unsubscribes = [
    appAtomRegistry.subscribe(reportTargetsAtom, report),
    subscribeClientSettings(report),
    subscribeClientSettingsHydration(report),
  ];
  report();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

export type ReportedProfiles = Map<
  EnvironmentId,
  { readonly config: EnvironmentServerConfig; readonly input: ProfileReport }
>;

/**
 * Returns the targets that need `input` reported and records them in `reported`. An
 * environment that dropped out of `targets` is forgotten, so it is reported again once it
 * becomes operable.
 */
export function takeDueProfileReports(
  reported: ReportedProfiles,
  targets: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>,
  input: ProfileReport,
): EnvironmentId[] {
  for (const environmentId of reported.keys()) {
    if (!targets.has(environmentId)) reported.delete(environmentId);
  }
  const due: EnvironmentId[] = [];
  for (const [environmentId, config] of targets) {
    const last = reported.get(environmentId);
    if (last && last.config === config && sameReportInput(last.input, input)) continue;
    reported.set(environmentId, { config, input });
    due.push(environmentId);
  }
  return due;
}

function sameReportInput(left: ProfileReport, right: ProfileReport): boolean {
  return (
    left.profiles === right.profiles &&
    left.defaultProfileId === right.defaultProfileId &&
    left.recordingFrameRate === right.recordingFrameRate
  );
}
