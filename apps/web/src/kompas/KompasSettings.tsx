import { T, useGT } from "gt-react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Switch } from "../components/ui/switch";
import { useAtomCommand } from "../state/use-atom-command";
import { kompasEnvironment, useKompas, useReportFailure } from "./state";

export function KompasSettings() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const kompas = useKompas();
  const reportFailure = useReportFailure();
  const updateSettings = useAtomCommand(kompasEnvironment.updateSettings, { reportFailure: false });
  if (kompas === null) return null;
  return (
    <SettingsSection id="mode" title={gt("Mode")}>
      <SettingsRow
        {...setting("developer-mode")}
        description={
          <T>
            Show the coding tools: projects on disk, branches, diffs, terminal and pull requests.
          </T>
        }
        control={
          <Switch
            aria-label={gt("Developer mode")}
            checked={kompas.snapshot.settings.developerMode}
            onCheckedChange={(developerMode) =>
              void updateSettings({
                environmentId: kompas.environmentId,
                input: { developerMode },
              }).then(reportFailure)
            }
          />
        }
      />
    </SettingsSection>
  );
}
