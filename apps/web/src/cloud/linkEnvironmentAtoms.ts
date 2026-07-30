import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  linkPrimaryEnvironmentToCloud,
  type CloudLinkMode,
  type CloudLinkTarget,
  unlinkPrimaryEnvironmentFromCloud,
  unlinkRelayEnvironmentFromCloud,
  updatePrimaryCloudPreferences,
} from "./linkEnvironment";

const cloudLinkScheduler = createAtomCommandScheduler();
const cloudLinkConcurrency = {
  mode: "serial" as const,
  key: (input: { readonly target: CloudLinkTarget }) => input.target.environmentId,
};

export const linkPrimaryEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:link-primary-environment",
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: {
    readonly target: CloudLinkTarget;
    readonly clerkToken: string;
    readonly mode?: CloudLinkMode;
  }) => linkPrimaryEnvironmentToCloud(input),
});

export const unlinkPrimaryEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:unlink-primary-environment",
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: { readonly target: CloudLinkTarget; readonly clerkToken: string | null }) =>
    unlinkPrimaryEnvironmentFromCloud(input),
});

export const unlinkRelayEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:unlink-relay-environment",
  scheduler: cloudLinkScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
  },
  execute: (input: { readonly environmentId: EnvironmentId; readonly clerkToken: string }) =>
    unlinkRelayEnvironmentFromCloud(input),
});

export const updatePrimaryEnvironmentPreferences = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:update-primary-environment-preferences",
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: { readonly target: CloudLinkTarget; readonly publishAgentActivity: boolean }) =>
    updatePrimaryCloudPreferences(input),
});
