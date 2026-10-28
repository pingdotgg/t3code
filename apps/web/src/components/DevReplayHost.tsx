import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { useProjects, useThreadShell } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerProvidersAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { Button } from "./ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./ui/dialog";
import { toastManager } from "./ui/toast";

// Dev servers register this free ACP agent; see ProviderInstanceRegistryHydration.ts.
const DEV_REPLAY_INSTANCE_ID = ProviderInstanceId.make("devReplay");

/**
 * Starts free replay threads on the primary environment in dev builds. Ctrl+Alt+Shift+R
 * opens a picker, and `window.t3dev.replay(scenario)` does the same from the console.
 */
export function DevReplayHost() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects();
  const target = resolveThreadRouteTarget(useParams({ strict: false }));
  const routeThread = useThreadShell(target?.kind === "server" ? target.threadRef : null);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });

  const replayProvider = providers.find(
    (provider) => provider.instanceId === DEV_REPLAY_INSTANCE_ID && provider.enabled,
  );
  const scenarios = replayProvider?.models ?? [];
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const project =
    environmentProjects.find((candidate) => candidate.id === routeThread?.projectId) ??
    environmentProjects[0];

  const replay = async (scenario?: string): Promise<ThreadId> => {
    const model = scenario ?? scenarios[0]?.slug;
    if (environmentId === null || project === undefined || model === undefined) {
      throw new Error("Replay needs a dev server with a project and the Replay (dev) provider.");
    }
    if (!scenarios.some((candidate) => candidate.slug === model)) {
      throw new Error(`Unknown replay scenario "${model}".`);
    }
    const threadId = newThreadId();
    const modelSelection = { instanceId: DEV_REPLAY_INSTANCE_ID, model };
    const title = `Replay: ${model}`;
    const createdAt = new Date().toISOString();
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: { messageId: newMessageId(), role: "user", text: title, attachments: [] },
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: project.id,
            title,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          },
        },
        createdAt,
      },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
    return threadId;
  };

  const replayFromConsole = useEffectEvent(replay);
  const listScenarios = useEffectEvent(() => scenarios.map((scenario) => scenario.slug));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- exposes the console API on window and listens for the hidden window hotkey
  useEffect(() => {
    window.t3dev = {
      replayScenarios: () => listScenarios(),
      replay: (scenario) => replayFromConsole(scenario),
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.ctrlKey && event.altKey && event.shiftKey && event.code === "KeyR") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      delete window.t3dev;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const start = (scenario: string) => {
    setOpen(false);
    replay(scenario).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Replay failed",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {project === undefined ? "Replay a recorded turn" : `Replay in ${project.title}`}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {scenarios.length === 0 || project === undefined ? (
            <p className="text-sm text-muted-foreground">
              Needs a project and the Replay (dev) provider, which dev servers start.
            </p>
          ) : (
            <div className="flex flex-col items-start gap-1">
              {scenarios.map((scenario) => (
                <Button key={scenario.slug} variant="ghost" onClick={() => start(scenario.slug)}>
                  {scenario.name}
                </Button>
              ))}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
