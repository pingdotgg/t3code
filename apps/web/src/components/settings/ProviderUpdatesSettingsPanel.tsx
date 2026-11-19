import type { EnvironmentId, ProviderRuntimeUpdateMode } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { providerRuntimeEnvironment } from "../../state/providerRuntimes";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const MODE_LABELS: Record<ProviderRuntimeUpdateMode, string> = {
  auto: "Keep up to date",
  notify: "Only show updates",
  off: "Off",
};

function failureText(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message ? error.message : "The update request failed.";
}

export function ProviderUpdatesSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return <ProviderUpdatesContent environmentId={environmentId} />;
}

function ProviderUpdatesContent({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const searchableSetting = useSearchableSetting();
  const query = useEnvironmentQuery(
    providerRuntimeEnvironment.status({ environmentId, input: {} }),
  );
  const updateSettings = useAtomCommand(providerRuntimeEnvironment.updateSettings, {
    reportFailure: false,
  });
  const checkNow = useAtomCommand(providerRuntimeEnvironment.checkNow, { reportFailure: false });
  const restore = useAtomCommand(providerRuntimeEnvironment.restore, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const status = query.data;
  if (status === null) return null;

  const settle = (result: Awaited<ReturnType<typeof checkNow>>) => {
    setError(result._tag === "Success" ? null : failureText(result));
    query.refresh();
  };

  return (
    <SettingsPageContainer>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <SettingsSection
        id="provider-updates"
        title="Provider updates"
        headerAction={
          <Button
            disabled={busy || status.checking}
            size="xs"
            variant="ghost"
            onClick={async () => {
              setBusy(true);
              settle(await checkNow({ environmentId, input: {} }));
              setBusy(false);
            }}
          >
            <RefreshCwIcon />
            {busy || status.checking ? "Checking…" : "Check now"}
          </Button>
        }
      >
        <SettingsRow
          {...searchableSetting("setting-provider-updates-mode")}
          description="Outdated Claude Code or Codex runs a current build Continuum downloads from the vendor; sign-ins and sessions carry over. Checked at startup and every 6 hours."
          control={
            <Select
              value={status.settings.mode}
              onValueChange={async (mode) =>
                settle(
                  await updateSettings({
                    environmentId,
                    input: { mode: mode as ProviderRuntimeUpdateMode },
                  }),
                )
              }
            >
              <SelectTrigger aria-label="Provider updates" className="w-full sm:w-52">
                <SelectValue>{MODE_LABELS[status.settings.mode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(Object.keys(MODE_LABELS) as Array<ProviderRuntimeUpdateMode>).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("setting-provider-updates-user-installs")}
          description="Also update CLIs you installed with npm, Homebrew, mise, or similar, using that installer. System packages such as Nix are never changed."
          control={
            <Switch
              aria-label="Update my installed CLIs"
              checked={status.settings.updateUserInstalls}
              onCheckedChange={async (updateUserInstalls) =>
                settle(await updateSettings({ environmentId, input: { updateUserInstalls } }))
              }
            />
          }
        />
        {status.managed.map((entry) => (
          <SettingsRow
            key={entry.instanceId}
            title={
              <span className="flex items-center gap-2">
                {entry.instanceId}
                <Badge variant="success">Managed · {entry.version}</Badge>
              </span>
            }
            description={entry.executablePath}
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={async () =>
                  settle(await restore({ environmentId, input: { instanceId: entry.instanceId } }))
                }
              >
                Use my installed CLI
              </Button>
            }
          />
        ))}
      </SettingsSection>
      {status.log.length > 0 ? (
        <SettingsSection id="provider-updates-log" title="Recent activity">
          {status.log.slice(0, 10).map((entry) => (
            <SettingsRow
              key={`${entry.at}-${entry.instanceId}-${entry.action}`}
              title={
                <span className="flex items-center gap-2">
                  {entry.instanceId}
                  <Badge variant={entry.ok ? "secondary" : "warning"}>{entry.action}</Badge>
                </span>
              }
              description={`${new Date(entry.at).toLocaleString()} · ${entry.message}`}
            />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
