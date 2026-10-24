import type { EnvironmentId, TerminalShellProfile } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";

// Pickers refresh on open, but simultaneous consumers share one request per environment.
const inflightByEnvironment = new Map<string, Promise<readonly TerminalShellProfile[] | null>>();

/** Lists the shells detected on `environmentId`; nothing is fetched until `load` runs. */
export function useTerminalShells(environmentId: EnvironmentId | null) {
  const canLoad = useAtomValue(terminalEnvironment.listShells.permissionAtom(environmentId));
  const listShells = useAtomCommand(terminalEnvironment.listShells, { reportFailure: false });
  const [loaded, setLoaded] = useState<{
    readonly environmentId: string;
    readonly shells: readonly TerminalShellProfile[] | null;
    readonly status: "loading" | "success" | "error";
  } | null>(null);

  const current = loaded?.environmentId === environmentId ? loaded : null;
  const shells = current?.shells ?? null;
  const status = current?.status ?? "idle";

  const load = async () => {
    if (environmentId === null || !canLoad) return;
    setLoaded({ environmentId, shells: null, status: "loading" });
    let pending = inflightByEnvironment.get(environmentId);
    if (!pending) {
      pending = listShells({ environmentId, input: {} }).then((result) => {
        inflightByEnvironment.delete(environmentId);
        if (result._tag !== "Success") return null;
        return result.value.shells;
      });
      inflightByEnvironment.set(environmentId, pending);
    }
    const next = await pending;
    setLoaded({ environmentId, shells: next, status: next === null ? "error" : "success" });
  };

  return { shells: canLoad ? shells : null, status, load, canLoad };
}
