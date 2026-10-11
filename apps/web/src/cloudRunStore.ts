import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
export { preferredCloudEnvironment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { connectionAtomRuntime } from "./connection/runtime";
import { resolveStorage } from "./lib/storage";

export const providerCloudEnvironments = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:providers:cloud-environments",
    tag: WS_METHODS.providerListCloudEnvironments,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
  },
);

const Preferences = Schema.Struct({ byProject: Schema.Record(Schema.String, Schema.String) });
const decodePreferences = Schema.decodeUnknownOption(Preferences);

interface CloudRunPreferences {
  byProject: Record<string, string>;
  remember: (projectKey: string, environmentId: string) => void;
}

/** Remember destinations per host, project, and account without changing provider settings. */
export const useCloudRunPreferences = create<CloudRunPreferences>()(
  persist(
    (set) => ({
      byProject: {},
      remember: (key, id) => set((state) => ({ byProject: { ...state.byProject, [key]: id } })),
    }),
    {
      name: "t3-cloud-run-preferences",
      storage: createJSONStorage(() =>
        resolveStorage(typeof localStorage === "undefined" ? undefined : localStorage),
      ),
      partialize: (state) => ({ byProject: state.byProject }),
      merge: (persisted, current) => {
        const decoded = decodePreferences(persisted);
        return decoded._tag === "Some"
          ? { ...current, byProject: { ...decoded.value.byProject } }
          : current;
      },
    },
  ),
);

export const providerCloudRepositories = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:providers:cloud-repositories",
    tag: WS_METHODS.providerListCloudRepositories,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
  },
);
export const providerCloudConfiguration = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:providers:cloud-configuration",
    tag: WS_METHODS.providerReadCloudConfiguration,
    staleTimeMs: 5_000,
    idleTtlMs: 5 * 60_000,
  },
);
export const mutateCloudEnvironment = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "cloud environment",
  tag: WS_METHODS.providerMutateCloudEnvironment,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}`,
  },
});
