import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useState } from "react";

import { APP_VERSION } from "../../branding";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsConfigPathAtom,
  primaryServerObservabilityAtom,
} from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { usePrimaryEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { AboutVersionSection } from "./SettingsPanels";
import { formatDiagnosticsDescription } from "./SettingsPanels.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type OpenPathTarget = "keybindings" | "logsDirectory";

function useAdvancedSettingsPanelState() {
  const [openingPathByTarget, setOpeningPathByTarget] = useState<Record<OpenPathTarget, boolean>>({
    keybindings: false,
    logsDirectory: false,
  });
  const [openPathErrorByTarget, setOpenPathErrorByTarget] = useState<
    Partial<Record<OpenPathTarget, string | null>>
  >({});

  const keybindingsConfigPath = useAtomValue(primaryServerKeybindingsConfigPathAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const observability = useAtomValue(primaryServerObservabilityAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
  const diagnosticsDescription = formatDiagnosticsDescription({
    localTracingEnabled: observability?.localTracingEnabled ?? false,
    otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
    otlpTracesUrl: observability?.otlpTracesUrl,
    otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
    otlpMetricsUrl: observability?.otlpMetricsUrl,
  });

  const openInPreferredEditor = useCallback(
    (target: OpenPathTarget, path: string | null, failureMessage: string) => {
      if (!path) return;
      setOpenPathErrorByTarget((existing) => ({ ...existing, [target]: null }));

      const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
      if (!editor) {
        setOpenPathErrorByTarget((existing) => ({
          ...existing,
          [target]: "No available editors found.",
        }));
        return;
      }
      if (environmentId === null) {
        setOpenPathErrorByTarget((existing) => ({
          ...existing,
          [target]: "No environment is selected.",
        }));
        return;
      }

      setOpeningPathByTarget((existing) => ({ ...existing, [target]: true }));
      void (async () => {
        const result = await openInEditor({
          environmentId,
          input: {
            cwd: path,
            editor,
          },
        });
        setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setOpenPathErrorByTarget((existing) => ({
            ...existing,
            [target]: error instanceof Error ? error.message : failureMessage,
          }));
        }
      })();
    },
    [availableEditors, environmentId, openInEditor],
  );

  const openKeybindingsFile = useCallback(() => {
    openInPreferredEditor("keybindings", keybindingsConfigPath, "Unable to open keybindings file.");
  }, [keybindingsConfigPath, openInPreferredEditor]);

  const openLogsDirectory = useCallback(() => {
    openInPreferredEditor("logsDirectory", logsDirectoryPath, "Unable to open logs folder.");
  }, [logsDirectoryPath, openInPreferredEditor]);

  return {
    diagnosticsDescription,
    isOpeningKeybindings: openingPathByTarget.keybindings,
    isOpeningLogsDirectory: openingPathByTarget.logsDirectory,
    keybindingsConfigPath,
    logsDirectoryPath,
    openDiagnosticsError: openPathErrorByTarget.logsDirectory ?? null,
    openKeybindingsError: openPathErrorByTarget.keybindings ?? null,
    openKeybindingsFile,
    openLogsDirectory,
  };
}

export function AdvancedSettingsPanel() {
  const {
    diagnosticsDescription,
    isOpeningKeybindings,
    isOpeningLogsDirectory,
    keybindingsConfigPath,
    logsDirectoryPath,
    openDiagnosticsError,
    openKeybindingsError,
    openKeybindingsFile,
    openLogsDirectory,
  } = useAdvancedSettingsPanelState();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Files">
        <SettingsRow
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="text-code-compact block break-all font-mono text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings ? "Opening..." : "Open file"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Diagnostics">
        <SettingsRow
          title="Logs"
          description={diagnosticsDescription}
          status={
            <>
              <span className="text-code-compact block break-all font-mono text-foreground">
                {logsDirectoryPath ?? "Resolving logs directory..."}
              </span>
              {openDiagnosticsError ? (
                <span className="mt-1 block text-destructive">{openDiagnosticsError}</span>
              ) : null}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!logsDirectoryPath || isOpeningLogsDirectory}
              onClick={openLogsDirectory}
            >
              {isOpeningLogsDirectory ? "Opening..." : "Open logs folder"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Updates">
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                <span>Version</span>
                <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
              </span>
            }
            description="Current version of the application."
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
