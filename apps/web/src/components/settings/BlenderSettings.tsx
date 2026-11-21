import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type BlenderStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";

import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

type Translate = ReturnType<typeof useGT>;

function describeStatus(status: BlenderStatus, gt: Translate): string | null {
  switch (status._tag) {
    case "Disabled":
      return null;
    case "NotFound":
      return status.source === "override"
        ? gt("No executable at the configured path.")
        : gt("Blender was not found on PATH or in standard install locations.");
    case "Available":
      return status.source === "path"
        ? gt("Blender {version} on PATH at {path}.", {
            version: status.version,
            path: status.executablePath,
          })
        : gt("Blender {version} at {path}.", {
            version: status.version,
            path: status.executablePath,
          });
    case "Unsupported":
      return gt(
        "Blender {version} at {path} is older than {minimum}, the oldest supported release.",
        {
          version: status.version,
          path: status.executablePath,
          minimum: status.minimumVersion,
        },
      );
    case "ProbeFailed":
      switch (status.reason) {
        case "spawn-failed":
          return gt("Blender at {path} could not start.", { path: status.executablePath });
        case "timed-out":
          return gt("Blender at {path} did not report its version in time.", {
            path: status.executablePath,
          });
        case "nonzero-exit":
          return gt("Blender at {path} exited with code {code}.", {
            path: status.executablePath,
            code: String(status.exitCode ?? "?"),
          });
        case "unrecognized-output":
          return gt("Blender at {path} did not print a version.", { path: status.executablePath });
      }
  }
}

/** One environment's Blender: every read and write goes to the selected environment only. */
export function BlenderSettingsPanel() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected" && environment.serverConfig;
  const environmentId = connected ? environment.environmentId : null;
  return (
    <SettingsPageContainer>
      <SettingsSection id="blender" title={gt("Blender")}>
        <BlenderControls
          key={environmentId}
          environmentId={environmentId}
          settings={connected ? environment.serverConfig.settings.blender : null}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function BlenderControls({
  environmentId,
  settings,
}: {
  environmentId: EnvironmentId | null;
  settings: { readonly enabled: boolean; readonly executablePath: string } | null;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canChooseExecutable = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const enabled = settings?.enabled ?? false;
  const status = useEnvironmentQuery(
    environmentId === null || !canRead || !enabled
      ? null
      : serverEnvironment.blenderStatus({ environmentId, input: {} }),
  );
  const executablePath = settings?.executablePath ?? "";
  const save = (patch: { enabled?: boolean; executablePath?: string }) =>
    updateSettings({ blender: patch }, { onSaved: status.refresh });

  const statusText = status.error ?? (status.data ? describeStatus(status.data, gt) : null);

  return (
    <>
      <SettingsRow
        {...searchableSetting("blender-enabled")}
        description={gt("Run the Blender installed on this environment.")}
        status={enabled ? (status.isPending ? gt("Checking…") : statusText) : null}
        control={
          <>
            {enabled ? (
              <Button
                size="sm"
                variant="outline"
                disabled={status.isPending || !canRead || environmentId === null}
                onClick={status.refresh}
              >
                {gt("Check again")}
              </Button>
            ) : null}
            <Switch
              checked={enabled}
              disabled={!canWrite || settings === null}
              aria-label={gt("Use Blender")}
              onCheckedChange={(checked) => save({ enabled: Boolean(checked) })}
            />
          </>
        }
      />
      <SettingsRow
        {...searchableSetting("blender-executable")}
        description={gt("Leave empty to find Blender on PATH or in standard install locations.")}
        status={
          canChooseExecutable || settings === null
            ? null
            : gt("This connection cannot choose which executable the environment runs.")
        }
        resetAction={
          canChooseExecutable && executablePath !== "" ? (
            <SettingResetButton
              ariaLabel={gt("Reset Blender executable to automatic detection")}
              onClick={() => save({ executablePath: "" })}
            />
          ) : null
        }
        control={
          <DraftInput
            nativeInput
            size="sm"
            className="w-full sm:w-64"
            aria-label={gt("Blender executable")}
            placeholder={gt("Detect automatically")}
            autoCapitalize="none"
            spellCheck={false}
            disabled={!canChooseExecutable || settings === null}
            value={executablePath}
            onCommit={(next) => save({ executablePath: next.trim() })}
          />
        }
      />
    </>
  );
}
