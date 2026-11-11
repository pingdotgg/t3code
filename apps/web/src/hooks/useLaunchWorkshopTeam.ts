import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  WORKSHOP_TEAM_TEMPLATE,
  type ScopedProjectRef,
} from "@t3tools/contracts";
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

const LEAD_STARTER_PROMPT = [
  "You are the Workshop lead for this repository.",
  "Pinned teammates:",
  ...WORKSHOP_TEAM_TEMPLATE.seats
    .filter((seat) => seat.id !== "lead")
    .map((seat) => `- ${seat.title}: ${seat.roleBrief}`),
  "",
  "Ask what outcome I want, then coordinate Builder / QA / Reviewer. Prefer delegating specialist work over doing it yourself.",
].join("\n");

/**
 * One-click OpenRig-style Workshop team: durable Lead / Builder / QA / Reviewer
 * threads in the active project. Opens the Lead seat with a starter brief.
 */
export function useLaunchWorkshopTeam() {
  const router = useRouter();
  const launch = useAtomCommand(threadEnvironment.launchTeamTemplate, {
    reportFailure: false,
  });

  return async (projectRef: ScopedProjectRef) => {
    const project = readProject(projectRef);
    if (project === null) {
      toastManager.add({
        type: "error",
        title: "Could not launch Workshop team",
        description: "That project is no longer available.",
      });
      return;
    }

    const environmentServerConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const serverConfig = environmentServerConfigs.get(projectRef.environmentId);
    if (serverConfig?.environment.capabilities.teamTemplates !== true) {
      toastManager.add({
        type: "error",
        title: "Could not launch Workshop team",
        description: "This environment does not support starter team templates yet.",
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
        title: "Could not launch Workshop team",
        description: "Pick a default model for this project, then try again.",
      });
      return;
    }

    const requestingRouteHref = router.state.location.href;
    let pendingToastId: ReturnType<typeof toastManager.add> | undefined;
    const pendingTimer = setTimeout(() => {
      pendingToastId = toastManager.add({
        type: "loading",
        title: "Launching Workshop team…",
        timeout: 0,
      });
    }, 400);

    const result = await launch({
      environmentId: projectRef.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        projectId: project.id,
        templateId: WORKSHOP_TEAM_TEMPLATE.id,
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
          title: "Could not launch Workshop team",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }

    const lead = result.value.seats.find((seat) => seat.seatId === "lead") ?? result.value.seats[0];
    if (router.state.location.href !== requestingRouteHref) return;

    const leadRef = scopeThreadRef(projectRef.environmentId, lead.threadId);
    useComposerDraftStore.getState().setPrompt(leadRef, LEAD_STARTER_PROMPT);
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(leadRef),
    });
    toastManager.add({
      type: "success",
      title: "Workshop team ready",
      description: `${result.value.seats.length} pinned seats · talk to ${lead.title}`,
    });
  };
}
