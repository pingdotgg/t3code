import * as Effect from "effect/Effect";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

const label = "web:cloud-sandbox-profiles";

export const sandboxProfilesList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: `${label}:list`,
  tag: WS_METHODS.cloudSandboxProfilesList,
  // Spend and budgets move as workspaces allocate; keep answers fresh briefly.
  staleTimeMs: 30_000,
});

export const sandboxProfilesSave = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: `${label}:save`,
  tag: WS_METHODS.cloudSandboxProfilesSave,
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(sandboxProfilesList({ environmentId, input: {} }))),
});

export const sandboxProfilesDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: `${label}:delete`,
  tag: WS_METHODS.cloudSandboxProfilesDelete,
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(sandboxProfilesList({ environmentId, input: {} }))),
});

export const sandboxProfilesTest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: `${label}:test`,
  tag: WS_METHODS.cloudSandboxProfilesTest,
});
