import { useAtomValue } from "@effect/atom-react";

import { serverEnvironment } from "../../../state/server";
import { pickTriageEnvironment } from "../../triage/triageTarget";
import { useStartTriage } from "../../triage/useStartTriage";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function TriageSettingsSection(props: { readonly targets: readonly SettingsTarget[] }) {
  const startTriage = useStartTriage();
  const triageEnvironmentId = pickTriageEnvironment({
    onScreen: null,
    connected: props.targets.map((target) => target.environmentId),
    supportsTriage: (environmentId) =>
      props.targets.some(
        (target) =>
          target.environmentId === environmentId &&
          target.serverConfig.environment.capabilities.triage === true,
      ),
  });
  const permitted = useAtomValue(
    serverEnvironment.prepareTriage.permissionAtom(triageEnvironmentId),
  );
  if (triageEnvironmentId === null || !permitted) return null;
  const label = props.targets.find((target) => target.environmentId === triageEnvironmentId)?.label;
  return (
    <SettingsSection title="Troubleshooting">
      <SettingsRow
        icon="ladybug"
        label="Triage an issue"
        value={`On ${label ?? "this machine"}`}
        valuePosition="below"
        onPress={() => void startTriage(triageEnvironmentId)}
      />
    </SettingsSection>
  );
}
