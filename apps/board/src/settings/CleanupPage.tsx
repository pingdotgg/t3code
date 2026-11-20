import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerSettings, StorageCleanupReport } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { serverEnvironment } from "../state/server";
import { DeleteNow } from "./cleanup/DeleteNow";
import { PolicySection } from "./cleanup/PolicySection";
import { WorktreeSection } from "./cleanup/WorktreeSection";
import { latestReport, removedWorktreePaths, type SettingsInput } from "./settingsModel";

export function CleanupPage({
  settings,
  environmentId,
  project,
  projects,
  save,
}: {
  settings: ServerSettings;
  environmentId: EnvironmentId;
  project: EnvironmentProject | null;
  projects: ReadonlyArray<EnvironmentProject>;
  save: (input: SettingsInput) => void;
}) {
  const pushed = AsyncResult.getOrElse(
    useAtomValue(serverEnvironment.storageCleanupReport({ environmentId, input: {} })),
    () => null,
  );
  const [ran, setRan] = useState<StorageCleanupReport | null>(null);
  const report = latestReport(pushed, ran);
  return (
    <div className="flex flex-col gap-6">
      <PolicySection settings={settings} project={project} save={save} />
      <DeleteNow settings={settings} environmentId={environmentId} report={report} onRan={setRan} />
      <WorktreeSection
        project={project}
        projects={projects}
        removedPaths={removedWorktreePaths(report)}
      />
    </div>
  );
}
