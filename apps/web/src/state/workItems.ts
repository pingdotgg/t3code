import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const findWorkItemMatches = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:work-items:find-matches",
  tag: WS_METHODS.workItemsFindMatches,
});

export const workItemLinks = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:work-items:list-links",
    tag: WS_METHODS.workItemsListLinks,
  }),
  link: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:work-items:link",
    tag: WS_METHODS.workItemsLink,
  }),
  unlink: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:work-items:unlink",
    tag: WS_METHODS.workItemsUnlink,
  }),
};
