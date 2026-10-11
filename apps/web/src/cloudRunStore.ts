import { createCloudEnvironmentAtoms } from "@t3tools/client-runtime/state/cloud-environments";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { connectionAtomRuntime } from "./connection/runtime";
import { resolveStorage } from "./lib/storage";

export const cloudEnvironments = createCloudEnvironmentAtoms(connectionAtomRuntime);

const Preferences = Schema.Struct({ byProject: Schema.Record(Schema.String, Schema.String) });
const decodePreferences = Schema.decodeUnknownOption(Preferences);

interface CloudRunPreferences {
  byProject: Record<string, string>;
  remember: (projectKey: string, environmentId: string) => void;
}

/** The cloud environment last chosen per host, project, and provider instance. */
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
