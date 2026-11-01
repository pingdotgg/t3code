import { useAtomValue } from "@effect/atom-react";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function ProductAnalyticsControl({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.productAnalyticsConsent === true;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const [pending, setPending] = useState(false);

  return (
    <SettingsRow
      title={`Share product analytics · ${label}`}
      description={
        supported
          ? "Usage events go to T3 Code and PostHog with hashed account and installation IDs. These are pseudonymous: they can link activity across installations. No prompts or file contents. Turning this off discards queued events for everyone using this environment."
          : "Update this environment's server to control product analytics here. Older servers may collect analytics by default."
      }
      control={
        <Switch
          aria-label={`Share product analytics on ${label}`}
          checked={supported && (settings?.telemetryEnabled ?? false)}
          disabled={!supported || pending || !canWrite || settings === null}
          onCheckedChange={(enabled) => {
            setPending(true);
            void updateSettings({
              environmentId,
              input: { patch: { telemetryEnabled: enabled } },
            }).finally(() => setPending(false));
          }}
        />
      }
    />
  );
}
