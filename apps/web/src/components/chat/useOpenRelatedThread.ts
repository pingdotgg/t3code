import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useRef } from "react";
import { msg } from "gt-react";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell, waitForThreadShell } from "../../state/entities";
import { environmentShell } from "../../state/shell";
import { serverEnvironment } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";
import { resolveThreadOpenRoute } from "../../lib/sideChatPane";

const RELATED_THREAD_SHELL_WAIT_MS = 1_000;

export function useOpenRelatedThread(input: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
}) {
  const { environmentId, routeThreadKey, currentRouteThreadKeyRef } = input;
  const navigate = useNavigate();
  const router = useRouter();
  const openRelatedThreadGenerationRef = useRef(0);
  const onOpenRelatedThread = async (threadId: ThreadId, targetEnvironmentId = environmentId) => {
    const generation = ++openRelatedThreadGenerationRef.current;
    const threadRef = scopeThreadRef(targetEnvironmentId, threadId);
    const isEnvironmentLive = () =>
      appAtomRegistry.get(environmentShell.stateValueAtom(targetEnvironmentId)).status === "live";
    // The shell can leave idle subagent children out, so absence is not deletion there: the
    // route decides from the thread's own detail.
    const shellOmitsChildren =
      appAtomRegistry.get(serverEnvironment.configValueAtom(targetEnvironmentId))
        ?.shellThreadFamilies === true;
    // A just-launched child can reach this timeline before its shell syncs.
    if (!shellOmitsChildren && isEnvironmentLive() && readThreadShell(threadRef) === null) {
      const location = router.latestLocation;
      await waitForThreadShell(threadRef, RELATED_THREAD_SHELL_WAIT_MS);
      if (
        generation !== openRelatedThreadGenerationRef.current ||
        currentRouteThreadKeyRef.current !== routeThreadKey ||
        router.latestLocation !== location
      ) {
        return;
      }
    }
    const shell = readThreadShell(threadRef);
    if (shell === null ? !shellOmitsChildren && isEnvironmentLive() : shell.deletedAt != null) {
      toastManager.add({ type: "info", title: m(msg("This thread is no longer available")) });
      return;
    }
    const routeRef = resolveThreadOpenRoute(threadRef, shell);
    if (scopedThreadKey(routeRef) === routeThreadKey) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(routeRef),
    });
  };
  return onOpenRelatedThread;
}
