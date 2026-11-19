import { createIweEnvironmentAtoms } from "@t3tools/client-runtime/state/iwe";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

import { environmentThreadShells } from "./threads";

export const iweEnvironment = createIweEnvironmentAtoms(connectionAtomRuntime, (ref) =>
  Atom.map(environmentThreadShells.threadShellAtom(ref), (thread) =>
    thread?.latestRun ? `${thread.latestRun.runId}:${thread.latestRun.status}` : null,
  ),
);
