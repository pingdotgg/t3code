import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

const serialPerEnvironment = {
  mode: "serial" as const,
  key: (target: { readonly environmentId: string }) => target.environmentId,
};

/**
 * An environment serving itself over Tailcat: the live remote-access state
 * stream plus the commands that change it. All keyed by environment id, so the
 * settings screen can drive whichever environment it is looking at.
 */
export const tailcatEnvironment = {
  remoteAccess: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:tailcat:remote-access",
    tag: WS_METHODS.tailcatSubscribeRemoteAccess,
  }),
  setRemoteAccessEnabled: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:tailcat:set-remote-access-enabled",
    tag: WS_METHODS.tailcatSetRemoteAccessEnabled,
    concurrency: serialPerEnvironment,
  }),
  createConnectionCode: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:tailcat:create-connection-code",
    tag: WS_METHODS.tailcatCreateConnectionCode,
  }),
  revokeTrustedPeer: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:tailcat:revoke-trusted-peer",
    tag: WS_METHODS.tailcatRevokeTrustedPeer,
  }),
  renameTrustedPeer: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:tailcat:rename-trusted-peer",
    tag: WS_METHODS.tailcatRenameTrustedPeer,
  }),
  regenerateIdentity: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:tailcat:regenerate-identity",
    tag: WS_METHODS.tailcatRegenerateIdentity,
    concurrency: serialPerEnvironment,
  }),
};
