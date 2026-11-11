import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, DEFAULT_SERVER_SETTINGS, type ScopedProjectRef } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { useRouter } from "@tanstack/react-router";

import { useComposerDraftStore } from "../composerDraftStore";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Install a repo-shipped contributor bundle (t3.contributor-bundle.json):
 * pinned specialist seats plus a lead composer draft that includes the
 * project orientation map.
 */
export function useInstallContributorBundle() {
  const router = useRouter();
  const install = useAtomCommand(threadEnvironment.installContributorBundle, {
    reportFailure: false,
  });

  return async (projectRef: ScopedProjectRef) => {
    const project = readProject(projectRef);
    if (project === null) {
      toastManager.add({
        type: "error",
        title: "Could not install contributor bundle",
        description: "That project is no longer available.",
      });
      return;
    }

    const environmentServerConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const serverConfig = environmentServerConfigs.get(projectRef.environmentId);
    if (serverConfig?.environment.capabilities.contributorBundles !== true) {
      toastManager.add({
        type: "error",
        title: "Could not install contributor bundle",
        description: "This environment does not support contributor bundles yet.",
      });
      return;
    }

    const settings = serverConfig.settings ?? DEFAULT_SERVER_SETTINGS;
    const projectSettings = resolveProjectSettings(settings, project.id, project);
    const modelResolution = resolveNewThreadModelSelection({
      defaultSelection:
        projectSettings.settings.defaultModelSelection ??
        resolveProjectDefaultProviderModelSelection(
          serverConfig.providers ?? [],
          settings,
          project.id,
        ),
      fallbackSelection: settings.fallbackModelSelection ?? null,
      providers: serverConfig.providers ?? [],
      settings,
      projectId: project.id,
      now: Date.now(),
    });
    if (modelResolution.selection === null) {
      toastManager.add({
        type: "error",
        title: "Could not install contributor bundle",
        description: "Pick a default model for this project, then try again.",
      });
      return;
    }

    const requestingRouteHref = router.state.location.href;
    let pendingToastId: ReturnType<typeof toastManager.add> | undefined;
    const pendingTimer = setTimeout(() => {
      pendingToastId = toastManager.add({
        type: "loading",
        title: "Installing contributor bundle…",
        timeout: 0,
      });
    }, 400);

    const result = await install({
      environmentId: projectRef.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        projectId: project.id,
        modelSelection: modelResolution.selection,
        runtimeMode: projectSettings.settings.defaultRuntimeMode,
        interactionMode: "default",
      },
    }).finally(() => {
      clearTimeout(pendingTimer);
      if (pendingToastId !== undefined) toastManager.close(pendingToastId);
    });

    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not install contributor bundle",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }

    const lead = result.value.seats[0];
    if (lead === undefined) return;
    if (router.state.location.href !== requestingRouteHref) return;

    const leadRef = scopeThreadRef(projectRef.environmentId, lead.threadId);
    useComposerDraftStore.getState().setPrompt(leadRef, result.value.leadPrompt);
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(leadRef),
    });
    toastManager.add({
      type: "success",
      title: `${result.value.name} ready`,
      description: `${result.value.seats.length} pinned seats · talk to ${lead.title}`,
    });
  };
}
