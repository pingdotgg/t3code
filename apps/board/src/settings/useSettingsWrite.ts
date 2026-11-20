import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useContext, useState } from "react";

import { engineEnvironmentIdAtom } from "../state/projects";
import { serverEnvironment } from "../state/server";
import { failureText } from "./failureText";
import type { SettingsInput } from "./settingsModel";

export type SaveStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly message: string };

/** Writes through the engine's `server.updateSettings`, which stores the patch and notifies every client. */
export function useSettingsWrite() {
  const registry = useContext(RegistryContext);
  const environmentId = useAtomValue(engineEnvironmentIdAtom);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  const save = async (input: SettingsInput) => {
    if (environmentId === null) {
      return setStatus({ kind: "failed", message: "The engine is not connected yet." });
    }
    setStatus({ kind: "saving" });
    const result = await runAtomCommand(
      registry,
      serverEnvironment.updateSettings,
      { environmentId, input },
      { reportFailure: false },
    );
    setStatus(
      result._tag === "Success"
        ? { kind: "saved" }
        : { kind: "failed", message: failureText(result) },
    );
  };

  return { status, save };
}
