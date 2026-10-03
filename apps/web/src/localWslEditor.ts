import { type EnvironmentId, WslDistroName } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "./hooks/useLocalStorage";

const LocalWslEditorPreference = Schema.NullOr(Schema.Struct({ distro: WslDistroName }));

/** This mapping belongs to the viewing device, not the environment or account. */
export function useLocalWslEditor(environmentId: EnvironmentId | null) {
  return useLocalStorage(
    `t3code:local-wsl-editor:${environmentId ?? "none"}`,
    null,
    LocalWslEditorPreference,
  );
}
