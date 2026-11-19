import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg } from "gt-react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { currentClientMetadata } from "~/connection/platform";
import { m } from "~/i18n/messages";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";
import { APP_NAME, CLI_COMMAND, LEGACY_CLI_COMMAND } from "@t3tools/shared/branding";

/**
 * How to run triage on a machine whose install this client cannot see. Either name may be another
 * program's there, so it is guidance, never a command to copy.
 */
export const TRIAGE_CLI_GUIDANCE = `run triage with ${APP_NAME}'s CLI (${CLI_COMMAND}, or legacy ${LEGACY_CLI_COMMAND})`;

/**
 * In-app `ada triage`: the server writes the session files and starts cloning
 * the matching source, then a No project draft opens with the playbook linked.
 * The draft hero explains the rest; the user picks a provider and describes
 * the problem.
 */
export function useStartTriage() {
  const router = useRouter();
  const { scratchWorkspaceRootFor } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  const prepare = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });

  // With no draft to show, a toast is the only place to point at the CLI.
  const fail = (description: string) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not start triage",
        description: `${description} Instead, open a terminal on that machine and ${TRIAGE_CLI_GUIDANCE}.`,
        timeout: 0,
      }),
    );
  const failWith = (
    result: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
  ) => {
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    fail(thrownErrorMessage(error, m) ?? m(msg("An error occurred.")));
  };

  // `routeChanged` tells the steps the user went elsewhere while they waited;
  // the draft then stays closed instead of pulling them away.
  const openTriageDraft = async (environmentId: EnvironmentId, routeChanged: () => boolean) => {
    const prepared = await prepare({
      environmentId,
      input: { client: currentClientMetadata() },
    });
    if (prepared._tag === "Failure") return failWith(prepared);
    const project = await openScratch({ environmentId, input: {} });
    if (project._tag === "Failure") return failWith(project);
    if (routeChanged()) return;
    // A null result means the user went elsewhere; only a throw is a failure.
    await handleNewThread(scopeProjectRef(project.value.environmentId, project.value.id), {
      prompt: prepared.value.prompt,
    }).catch(() => fail(`${APP_NAME} could not open a new thread.`));
  };

  return async (environmentId: EnvironmentId) => {
    if (scratchWorkspaceRootFor(environmentId) === null) {
      fail(m(msg("This machine cannot start threads without a project.")));
      return;
    }
    const requestingRouteHref = router.state.location.href;
    // The palette is already closed, and a slow network can hold up the source
    // lookup, so say something when the draft does not open at once.
    let pendingToastId: ReturnType<typeof toastManager.add> | undefined;
    const pendingTimer = setTimeout(() => {
      pendingToastId = toastManager.add({
        type: "loading",
        title: m(msg("Starting triage…")),
        timeout: 0,
      });
    }, 400);
    await openTriageDraft(
      environmentId,
      () => router.state.location.href !== requestingRouteHref,
    ).finally(() => {
      clearTimeout(pendingTimer);
      if (pendingToastId !== undefined) toastManager.close(pendingToastId);
    });
  };
}
