import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthPreviewOperateScope, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { Atom } from "effect/reactivity";

import {
  getClientSettings,
  getClientSettingsHydratedSnapshot,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
} from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProjects } from "~/state/entities";
import { environmentPresentations } from "~/state/presentation";
import { previewEnvironment } from "~/state/preview";
import { environmentProjects } from "~/state/projects";
import { environmentSession, sessionHasScope } from "~/state/session";

import { projectProfileIdsForEnvironment } from "./browserDefaults";

export interface ProfileReport {
  readonly profiles: ClientSettings["browserProfiles"];
  readonly defaultProfileId: ClientSettings["browserDefaultProfileId"];
  readonly recordingFrameRate: ClientSettings["browserRecordingFrameRate"];
  readonly projectProfileIds: Readonly<Record<ProjectId, string>>;
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
    const projects = readProjects();
    const inputFor = (environmentId: EnvironmentId): ProfileReport => ({
      profiles: settings.browserProfiles,
      defaultProfileId: settings.browserDefaultProfileId,
      recordingFrameRate: settings.browserRecordingFrameRate,
      projectProfileIds: projectProfileIdsForEnvironment(settings, environmentId, projects),
    });
    const targets = appAtomRegistry.get(reportTargetsAtom);
    for (const { environmentId, input } of takeDueProfileReports(reported, targets, inputFor)) {
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
    appAtomRegistry.subscribe(environmentProjects.projectsAtom, report),
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
 * Returns the targets that need a report, with the input each needs, and records them in
 * `reported`. An environment that dropped out of `targets` is forgotten, so it is reported
 * again once it becomes operable.
 */
export function takeDueProfileReports(
  reported: ReportedProfiles,
  targets: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>,
  inputFor: (environmentId: EnvironmentId) => ProfileReport,
): Array<{ readonly environmentId: EnvironmentId; readonly input: ProfileReport }> {
  for (const environmentId of reported.keys()) {
    if (!targets.has(environmentId)) reported.delete(environmentId);
  }
  const due: Array<{ readonly environmentId: EnvironmentId; readonly input: ProfileReport }> = [];
  for (const [environmentId, config] of targets) {
    const input = inputFor(environmentId);
    const last = reported.get(environmentId);
    if (last && last.config === config && sameReportInput(last.input, input)) continue;
    reported.set(environmentId, { config, input });
    due.push({ environmentId, input });
  }
  return due;
}

function sameReportInput(left: ProfileReport, right: ProfileReport): boolean {
  const leftProjects = Object.entries(left.projectProfileIds);
  return (
    left.profiles === right.profiles &&
    left.defaultProfileId === right.defaultProfileId &&
    left.recordingFrameRate === right.recordingFrameRate &&
    leftProjects.length === Object.keys(right.projectProfileIds).length &&
    leftProjects.every(
      ([projectId, profileId]) => right.projectProfileIds[projectId as ProjectId] === profileId,
    )
  );
}
