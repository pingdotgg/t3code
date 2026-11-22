import { createSandboxEnvironmentAtoms } from "@t3tools/client-runtime/state/sandboxes";
import type { EnvironmentId, SandboxListResult } from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const sandboxEnvironment = createSandboxEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_SANDBOX_STATE: SandboxListResult = {
  sandboxes: [],
  providers: [],
  defaultIdleTimeoutMinutes: 8,
};

export function useSandboxState(environmentId: EnvironmentId | null): {
  readonly state: SandboxListResult;
  readonly loaded: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    environmentId === null ? null : sandboxEnvironment.state({ environmentId, input: {} }),
    resolve,
  );
  return {
    state: query.data ?? EMPTY_SANDBOX_STATE,
    loaded: query.data !== null,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refresh,
  };
}
