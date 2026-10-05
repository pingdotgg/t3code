import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { usePrimarySettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { homeEnvironment } from "../../state/home";
import { primaryServerConfigAtom, primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const HOME_DESCRIPTION =
  "An agent that can act across all your projects and connected machines. It can answer questions and approve requests for you.";

/** Settings page for Home. Only a desktop app's own server can run it. */
export function HomeSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const homeWorkspaceRoot = useAtomValue(
    primaryServerConfigAtom,
    (config) => config?.homeWorkspaceRoot ?? null,
  );
  const homeThreadId = usePrimarySettings((settings) => settings.home.threadId);
  return (
    <SettingsPageContainer>
      <SettingsSection title="Home">
        {!isElectron || environmentId === null || homeWorkspaceRoot === null ? (
          <SettingsRow {...searchableSetting("home")} description="Home runs in the desktop app." />
        ) : homeThreadId === null ? (
          <HomeOffRows environmentId={environmentId} />
        ) : (
          <HomeOnRows
            environmentId={environmentId}
            threadId={homeThreadId}
            homeWorkspaceRoot={homeWorkspaceRoot}
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function reportHomeFailure(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

function useNavigateToThread() {
  const navigate = useNavigate();
  return (environmentId: EnvironmentId, threadId: ThreadId) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
}

function HomeOffRows({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const enable = useAtomCommand(homeEnvironment.enable, { reportFailure: false });
  const navigateToThread = useNavigateToThread();
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [pending, setPending] = useState(false);

  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const usable = (instanceId: string) =>
    entries.some((entry) => entry.instanceId === instanceId && entry.enabled && entry.isAvailable);
  // Start from the default model for new threads, else the first usable provider.
  const fallbackEntry = entries.find((entry) => entry.enabled && entry.isAvailable);
  const fallbackModel = fallbackEntry
    ? resolveAppModelSelectionForInstance(fallbackEntry.instanceId, settings, providers, null)
    : null;
  const selection =
    picked ??
    (settings.defaultModelSelection && usable(settings.defaultModelSelection.instanceId)
      ? settings.defaultModelSelection
      : fallbackEntry && fallbackModel
        ? createModelSelection(fallbackEntry.instanceId, fallbackModel)
        : null);

  const turnOn = async () => {
    if (selection === null) return;
    setPending(true);
    const result = await enable({ environmentId, input: { modelSelection: selection } });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportHomeFailure("Could not turn on Home", squashAtomCommandFailure(result));
      }
      return;
    }
    await navigateToThread(environmentId, result.value.threadId);
  };

  return (
    <SettingsRow
      {...searchableSetting("home")}
      description={HOME_DESCRIPTION}
      control={
        selection === null ? (
          <span className="text-sm text-muted-foreground">No providers available.</span>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={getCustomModelOptionsByInstance(
                settings,
                providers,
                selection.instanceId,
                selection.model,
              )}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onInstanceModelChange={(instanceId, model) =>
                setPicked(createModelSelection(instanceId, model))
              }
            />
            <Button size="sm" disabled={pending} onClick={() => void turnOn()}>
              Turn on Home
            </Button>
          </div>
        )
      }
    />
  );
}

function HomeOnRows(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  homeWorkspaceRoot: string;
}) {
  const { environmentId, threadId, homeWorkspaceRoot } = props;
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const providers = useAtomValue(primaryServerProvidersAtom);
  const availableEditors = useAtomValue(
    primaryServerConfigAtom,
    (config) => config?.availableEditors ?? [],
  );
  const startFresh = useAtomCommand(homeEnvironment.startFresh, { reportFailure: false });
  const disable = useAtomCommand(homeEnvironment.disable, { reportFailure: false });
  const openInEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const navigateToThread = useNavigateToThread();
  const [pending, setPending] = useState(false);

  const modelSelection = thread?.modelSelection ?? null;
  const modelEntry = modelSelection
    ? deriveProviderInstanceEntries(providers).find(
        (entry) => entry.instanceId === modelSelection.instanceId,
      )
    : undefined;
  const model = modelEntry?.models.find((option) => option.slug === modelSelection?.model);
  const modelLabel =
    modelSelection === null
      ? null
      : model
        ? getTriggerDisplayModelLabel(model)
        : modelSelection.model;

  const runStartFresh = async () => {
    setPending(true);
    const result = await startFresh({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportHomeFailure("Could not start a fresh Home", squashAtomCommandFailure(result));
      }
      return;
    }
    await navigateToThread(environmentId, result.value.threadId);
  };

  const turnOff = async () => {
    setPending(true);
    const result = await disable({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportHomeFailure("Could not turn off Home", squashAtomCommandFailure(result));
    }
  };

  const editInstructions = async () => {
    const separator =
      homeWorkspaceRoot.includes("\\") && !homeWorkspaceRoot.includes("/") ? "\\" : "/";
    const result = await openInEditor(
      `${homeWorkspaceRoot.replace(/[\\/]+$/, "")}${separator}AGENTS.md`,
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportHomeFailure("Could not open instructions", squashAtomCommandFailure(result));
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("home")}
        description={HOME_DESCRIPTION}
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigateToThread(environmentId, threadId)}
          >
            Open Home
          </Button>
        }
      />
      {modelLabel === null ? null : (
        <SettingsRow
          title="Model"
          control={<span className="text-sm text-muted-foreground">{modelLabel}</span>}
        />
      )}
      <SettingsRow
        title="Start fresh"
        description="New Home thread. The current one stays as a normal thread."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void runStartFresh()}
          >
            Start fresh
          </Button>
        }
      />
      <SettingsRow
        title="Instructions"
        description="AGENTS.md in the Home folder."
        control={
          <Button size="sm" variant="outline" onClick={() => void editInstructions()}>
            Edit
          </Button>
        }
      />
      <SettingsRow
        title="Turn off"
        description="Home stops. Its threads stay."
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={pending}
            onClick={() => void turnOff()}
          >
            Turn off
          </Button>
        }
      />
    </>
  );
}
