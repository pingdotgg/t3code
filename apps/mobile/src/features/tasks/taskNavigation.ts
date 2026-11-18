import { StackActions, useNavigation } from "@react-navigation/native";
import { resolveChangeRequestLinkTarget } from "@t3tools/client-runtime/change-request-links";
import type { OrbitConversationRef } from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useGT } from "gt-react-native";
import { Alert } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { orbitGatewayClient } from "../orbit/orbitGatewayClient";
import { connectOrbitEnvironment, orbitGatewayState } from "../orbit/orbitGatewayStore";

/** Pairs or turns on the agent's server, as the Orbit settings' Connect does. */
async function prepareConversationEnvironment(ref: OrbitConversationRef): Promise<boolean> {
  const entry = appAtomRegistry
    .get(environmentCatalog.catalogValueAtom)
    .entries.get(ref.environmentId);
  if (entry?.enabled) return true;
  const known =
    orbitGatewayState().environments.find((item) => item.environmentId === ref.environmentId) ??
    (await orbitGatewayClient.environments().catch(() => [])).find(
      (item) => item.environmentId === ref.environmentId,
    );
  if (known) return connectOrbitEnvironment(known);
  if (!entry) return false;
  const enabled = await runAtomCommand(
    appAtomRegistry,
    environmentCatalog.setEnabled,
    { environmentId: ref.environmentId, enabled: true },
    { reportFailure: false },
  );
  return enabled._tag === "Success";
}

/** Agents open in Conn's normal thread screen; Back returns to the task. Opening never runs work. */
export function useOpenTaskAgent() {
  const navigation = useNavigation();
  const gt = useGT();
  return async (ref: OrbitConversationRef) => {
    if (!(await prepareConversationEnvironment(ref))) {
      Alert.alert(
        gt("Conversation unavailable"),
        gt("This device cannot reach the server this agent runs on."),
      );
      return;
    }
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: String(ref.environmentId),
        threadId: String(ref.threadId),
      }),
    );
  };
}

/** A task's pull request opens Conn's pull request screen, or the browser when no project reads it. */
export function useOpenTaskPullRequest() {
  const navigation = useNavigation();
  const projects = useProjects();
  return (url: string) => {
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    const target = resolveChangeRequestLinkTarget({
      url,
      projects,
      configLoaded: (environmentId) =>
        configs.get(environmentId)?.environment.capabilities.pullRequests === true,
      lendHostProject: true,
    });
    if (!target) return void tryOpenExternalUrl(url, "pull-request");
    navigation.dispatch(
      StackActions.push("PullRequest", {
        environmentId: String(target.project.environmentId),
        projectId: String(target.project.id),
        repository: target.repository,
        number: target.number,
        ...(target.host === undefined ? {} : { host: target.host }),
      }),
    );
  };
}
