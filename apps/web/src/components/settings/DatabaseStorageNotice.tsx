import { useAtomValue } from "@effect/atom-react";
import { shouldRecommendDatabaseCompaction, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Suggests `t3 doctor` for a database that still holds at least 1 GiB of freed pages. */
export function DatabaseStorageNotice({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const result = useAtomValue(serverEnvironment.databaseStorage({ environmentId, input: {} }));
  const [dismissed, setDismissed] = useLocalStorage(
    `database-storage-notice-dismissed:${environmentId}`,
    false,
    Schema.Boolean,
  );
  const { copyToClipboard } = useCopyToClipboard({ target: "command" });
  const status = result._tag === "Success" ? result.value : null;
  if (dismissed || status === null || !shouldRecommendDatabaseCompaction(status)) return null;
  return (
    <SettingsSection id={`storage-database-${environmentId}`} title="Database">
      <SettingsGroup>
        <SettingsRow
          title={`Reclaim ${(status.reclaimableBytes / 1024 ** 3).toFixed(1)} GiB on ${label}`}
          description={
            <>
              Old history is cleaned up automatically, but this database still holds the freed
              space. Run the command on {label} to return it to disk; it pauses and restarts the
              background service. Quit the desktop app first if it hosts this environment.
              <code className="mt-2 block select-text break-all">{status.compactCommand}</code>
            </>
          }
          control={
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(status.compactCommand, undefined)}
              >
                Copy command
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
                Dismiss
              </Button>
            </div>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
