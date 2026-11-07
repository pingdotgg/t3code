import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useT } from "../../hooks/useI18n";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const DismissedEnvironmentIds = Schema.Array(Schema.String);

/** Suggests `t3 doctor` on every machine whose database still holds at least 1 GiB of freed pages. */
export function DatabaseStorageNotice({
  environments,
}: {
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
}) {
  const t = useT();
  const recommendations = useAtomValue(
    serverEnvironment.databaseCompactionRecommendations(
      JSON.stringify(environments.map((environment) => environment.environmentId)),
    ),
  );
  const [dismissed, setDismissed] = useLocalStorage(
    "database-storage-notice-dismissed",
    [],
    DismissedEnvironmentIds,
  );
  const { copyToClipboard } = useCopyToClipboard({ target: "command" });
  const visible = recommendations.filter(
    (recommendation) => !dismissed.includes(recommendation.environmentId),
  );
  if (visible.length === 0) return null;
  return (
    <SettingsSection id="storage-database" title={t("settings.system.dbNotice.title")}>
      <SettingsRow
        title={t("settings.system.dbNotice.reclaim.title")}
        description={t("settings.system.dbNotice.reclaim.description")}
      />
      {visible.map(({ environmentId, status }) => (
        <SettingsRow
          key={environmentId}
          title={t("settings.system.dbNotice.row.title", {
            size: (status.reclaimableBytes / 1024 ** 3).toFixed(1),
            label:
              environments.find((environment) => environment.environmentId === environmentId)
                ?.label ?? environmentId,
          })}
          description={<code className="select-text break-all">{status.compactCommand}</code>}
          control={
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="xs"
                onClick={() => copyToClipboard(status.compactCommand, undefined)}
              >
                {t("settings.system.dbNotice.copyCommand")}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setDismissed((current) => [...current, environmentId])}
              >
                {t("settings.system.dbNotice.dismiss")}
              </Button>
            </div>
          }
        />
      ))}
    </SettingsSection>
  );
}
