import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { createEnvironmentStreamAtomFamily } from "./environmentRpcStream";

/**
 * Federation as seen from one environment: its peers and the remote runs it
 * started, plus the commands that pair peers and drive work on them. Every
 * remote run executes on the peer; this environment only tracks it.
 */
export const federationEnvironment = {
  peers: createEnvironmentStreamAtomFamily(connectionAtomRuntime, {
    label: "environment-data:federation:peers",
    tag: WS_METHODS.federationSubscribePeers,
  }),
  remoteRuns: createEnvironmentStreamAtomFamily(connectionAtomRuntime, {
    label: "environment-data:federation:remote-runs",
    tag: WS_METHODS.federationSubscribeRemoteRuns,
  }),
  remoteProjects: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:federation:remote-projects",
    tag: WS_METHODS.federationListRemoteProjects,
    staleTimeMs: 30_000,
  }),
  createPeerCode: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:federation:create-peer-code",
    tag: WS_METHODS.federationCreatePeerCode,
  }),
  addPeer: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:federation:add-peer",
    tag: WS_METHODS.federationAddPeer,
  }),
  removePeer: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:federation:remove-peer",
    tag: WS_METHODS.federationRemovePeer,
  }),
  refreshPeer: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:federation:refresh-peer",
    tag: WS_METHODS.federationRefreshPeer,
  }),
  startRemoteRun: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:federation:start-remote-run",
    tag: WS_METHODS.federationStartRemoteRun,
  }),
  cancelRemoteRun: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:federation:cancel-remote-run",
    tag: WS_METHODS.federationCancelRemoteRun,
  }),
  describeRemoteArtifacts: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:federation:describe-remote-artifacts",
    tag: WS_METHODS.federationDescribeRemoteArtifacts,
  }),
  fetchRemoteArtifact: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:federation:fetch-remote-artifact",
    tag: WS_METHODS.federationFetchRemoteArtifact,
  }),
};
