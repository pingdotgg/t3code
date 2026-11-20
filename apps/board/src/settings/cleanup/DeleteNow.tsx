import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, ServerSettings, StorageCleanupReport } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useContext, useState } from "react";

import { failureText } from "../failureText";
import { SettingsRow } from "../SettingsRow";
import { SettingsSection } from "../SettingsSection";
import { formatBytes, hasCleanupRules } from "../settingsModel";
import { serverEnvironment } from "../../state/server";
import { CleanupResults } from "./CleanupResults";

export function DeleteNow({
  settings,
  environmentId,
  report,
  onRan,
}: {
  settings: ServerSettings;
  environmentId: EnvironmentId;
  report: StorageCleanupReport | null;
  onRan: (report: StorageCleanupReport) => void;
}) {
  const registry = useContext(RegistryContext);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const runnable = hasCleanupRules(settings);

  const run = async () => {
    setRunning(true);
    setFailure(null);
    const result = await runAtomCommand(
      registry,
      serverEnvironment.runStorageCleanup,
      { environmentId, input: {} },
      { reportFailure: false },
    );
    setRunning(false);
    if (result._tag === "Success") onRan(result.value);
    else setFailure(failureText(result));
  };

  return (
    <SettingsSection title="Run now">
      <SettingsRow
        title="Delete now"
        description={
          !runnable
            ? "Turn on a cleanup rule to use this."
            : report === null
              ? "Cleanup has not run yet."
              : `Last run ${new Date(report.finishedAt).toLocaleString()}. ${formatBytes(report.bytesFreed)} recovered.`
        }
        control={
          <button
            type="button"
            disabled={running || !runnable}
            onClick={() => void run()}
            className="rounded-md border border-line px-2.5 py-1 text-fg enabled:hover:bg-hover disabled:opacity-50"
          >
            {running ? "Deleting…" : "Delete now"}
          </button>
        }
      />
      {failure !== null && (
        <p role="alert" className="px-3 py-2 break-words text-red-400">
          {failure}
        </p>
      )}
      {report !== null && <CleanupResults report={report} />}
    </SettingsSection>
  );
}
