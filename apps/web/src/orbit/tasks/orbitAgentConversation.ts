import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  createOrbitGatewayClient,
  type OrbitConversationRef,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { pullRequestLinkPanelTarget } from "~/lib/openPullRequestLink";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useRightPanelStore } from "~/rightPanelStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "~/threadRoutes";
import { desktopOrbitGatewayTransport } from "../desktopOrbitGateway";
import { connectOrbitEnvironment } from "../environmentProvider";
import { beginSidebarPeek, isSidebarListedNow } from "../sidebarHiddenThreads";
import { tasksPanelActions, useTasksPanelStore } from "./tasksPanelStore";
import {
  openOrbitAgentConversation,
  prepareOrbitConversationEnvironment,
} from "./taskNavigation.logic";

/** Conn: a Tasks agent click peeks; marks go down before the environment connects. */
async function prepareEnvironment(target: OrbitConversationRef, peek: boolean) {
  const transport = desktopOrbitGatewayTransport();
  const client = transport ? createOrbitGatewayClient(transport) : null;
  const entry = appAtomRegistry
    .get(environmentCatalog.catalogValueAtom)
    .entries.get(target.environmentId);
  const attempt = peek
    ? beginSidebarPeek(target, {
        targetListed: isSidebarListedNow(target.environmentId, target.threadId),
        environmentSurfaced: entry?.enabled !== true,
      })
    : null;
  try {
    await prepareKnownEnvironment(target, client);
  } catch (cause) {
    attempt?.cancel();
    throw cause;
  }
  attempt?.commit();
}

async function prepareKnownEnvironment(
  target: OrbitConversationRef,
  client: ReturnType<typeof createOrbitGatewayClient> | null,
) {
  await prepareOrbitConversationEnvironment(target.environmentId, {
    known: () =>
      appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.has(target.environmentId),
    environments: client ? () => client.environments() : null,
    connect: (environment) =>
      client ? connectOrbitEnvironment(client, environment) : Promise.resolve(false),
    enable: async () => {
      const entry = appAtomRegistry
        .get(environmentCatalog.catalogValueAtom)
        .entries.get(target.environmentId);
      if (!entry) throw new Error("This environment is not paired on this device.");
      if (!entry.enabled) {
        const enabled = await runAtomCommand(
          appAtomRegistry,
          environmentCatalog.setEnabled,
          { environmentId: target.environmentId, enabled: true },
          { reportFailure: false },
        );
        if (enabled._tag !== "Success") throw squashAtomCommandFailure(enabled);
      }
    },
  });
}

export function useOrbitTaskNavigation(threadKey: string) {
  const router = useRouter();
  const sequence = useRef({ key: threadKey, id: 0 });
  const [error, setError] = useState<string | null>(null);
  const source = parseScopedThreadKey(threadKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates pending click work when the Tasks surface leaves
  useEffect(() => {
    sequence.current = { key: threadKey, id: sequence.current.id + 1 };
    return () => {
      sequence.current.id += 1;
    };
  }, [threadKey]);
  const navigate = async (ref: OrbitConversationRef, peek = true) => {
    if (!source) return;
    const request = ++sequence.current.id;
    setError(null);
    const isCurrent = () => {
      const params = router.state.matches.at(-1)?.params ?? {};
      const current = resolveThreadRouteRef(params);
      return (
        request === sequence.current.id &&
        sequence.current.key === threadKey &&
        current !== null &&
        scopedThreadKey(current) === threadKey
      );
    };
    try {
      await openOrbitAgentConversation(ref, {
        source,
        isCurrent,
        prepare: (target) => prepareEnvironment(target, peek),
        handoff: (from, to) => {
          tasksPanelActions().handoff(scopedThreadKey(from), scopedThreadKey(to));
          useRightPanelStore.getState().open(to, "tasks");
        },
        navigate: async (target) => {
          await router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(target),
          });
        },
      });
    } catch (cause) {
      if (isCurrent())
        setError(cause instanceof Error ? cause.message : "Could not open this conversation.");
    }
  };
  const openPullRequest = (url: string) => {
    if (!source) return;
    sequence.current.id += 1;
    const target = pullRequestLinkPanelTarget({
      url,
      environmentId: undefined,
      primaryEnvironmentId: source.environmentId,
      lendHostProject: true,
    });
    if (!target) {
      setError(
        "No connected project can open this pull request. Connect its repository in Connections, then try again.",
      );
      return;
    }
    setError(null);
    useRightPanelStore.getState().openPullRequest(source, {
      environmentId: target.project.environmentId,
      projectId: target.project.id,
      repository: target.repository,
      number: target.number,
      ...(target.host === undefined ? {} : { host: target.host }),
      url,
    });
  };
  const returnToOrigin = () => {
    const key = useTasksPanelStore.getState().byThreadKey[threadKey]?.originThreadKey;
    const target = key ? parseScopedThreadKey(key) : null;
    // Back to where the user came from: no peek, so the origin keeps its sidebar state.
    if (target) void navigate(target, false);
  };
  return {
    openAgent: (ref: OrbitConversationRef) => navigate(ref),
    openPullRequest,
    returnToOrigin,
    error,
  };
}
