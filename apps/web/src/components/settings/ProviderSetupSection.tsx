import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";

interface ProviderSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
}

export function ProviderSetupSection(props: ProviderSetupSectionProps) {
  const gt = useGT();
  return (
    <section
      aria-label={gt("Antigravity setup")}
      className="@container/setup divide-y divide-border/50 text-xs [&_[data-slot=settings-row]]:rounded-none"
    >
      <SettingsRow
        className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
        title={gt("Environment")}
        description={gt("Device that runs this provider.")}
        control={
          <div className="flex min-w-0 flex-col gap-2 sm:items-end">
            <span className="text-muted-foreground [overflow-wrap:anywhere]">
              {props.environmentLabel}
            </span>
            {!props.enabled && !props.readOnly ? (
              <Button size="sm" variant="outline" onClick={props.onEnable}>
                <T>Enable Antigravity</T>
              </Button>
            ) : null}
          </div>
        }
      />
      {props.readOnly ? (
        <SettingsRow
          title={gt("Setup unavailable")}
          description={gt("Provider setup is read-only.")}
        />
      ) : props.provider?.setup === undefined ? (
        <SettingsRow
          title={gt("Update required")}
          description={gt("Update this environment to manage Antigravity.")}
        />
      ) : (
        <ProviderAuthenticationSection
          key={`${props.environmentId}:${props.instanceId}`}
          environmentId={props.environmentId}
          environmentLabel={props.environmentLabel}
          instanceId={props.instanceId}
          provider={props.provider}
          readOnly={false}
        />
      )}
    </section>
  );
}
