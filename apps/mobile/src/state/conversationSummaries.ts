import { createConversationSummariesAtoms } from "@t3tools/client-runtime/conversationSummaries";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

export const conversationSummaries = createConversationSummariesAtoms(connectionAtomRuntime);
export const conversationSummariesSupportedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
        .conversationSummaries === true,
  ),
);
export const conversationSummarySearchSupportedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
        .conversationSummarySourceFormat === 2,
  ),
);
