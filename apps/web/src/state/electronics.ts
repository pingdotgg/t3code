import { createElectronicsEnvironmentAtoms } from "@t3tools/client-runtime/state/electronics";
import type { ElectronicsServiceState, EnvironmentId } from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const electronicsEnvironment = createElectronicsEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_ELECTRONICS_STATE: ElectronicsServiceState = {
  toolchain: {
    enabled: true,
    allowExternalTools: true,
    agentAccessEnabled: true,
    kicadCli: { name: "kicad-cli", available: false },
    ngspice: { name: "ngspice", available: false },
    checkedAt: "",
  },
  sessions: [],
};

export function useElectronicsState(environmentId: EnvironmentId | null): {
  readonly state: ElectronicsServiceState;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    environmentId === null ? null : electronicsEnvironment.state({ environmentId, input: {} }),
    resolve,
  );
  return {
    state: query.data ?? EMPTY_ELECTRONICS_STATE,
    loaded: query.data !== null,
    error: query.error,
    refresh: query.refresh,
  };
}
