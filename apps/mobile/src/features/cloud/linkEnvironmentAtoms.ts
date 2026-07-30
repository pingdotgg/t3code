import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";
import { deregisterRelayEnvironment } from "./linkEnvironment";

const cloudLinkScheduler = createAtomCommandScheduler();

export const deregisterEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:cloud:deregister-environment",
  scheduler: cloudLinkScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
  },
  execute: deregisterRelayEnvironment,
});
