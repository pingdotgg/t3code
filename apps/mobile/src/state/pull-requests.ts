import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

export const composerPullRequests = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "mobile:composer:pull-requests",
    tag: WS_METHODS.pullRequestsList,
    staleTimeMs: 30_000,
  }),
  detail: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "mobile:composer:pull-request-detail",
    tag: WS_METHODS.pullRequestsDetail,
    staleTimeMs: 60_000,
  }),
};
