import { WS_METHODS, ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createTaskDocumentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    register: createEnvironmentRpcCommand(runtime, {
      label: "task-documents:register",
      tag: WS_METHODS.taskDocumentsRegister,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "task-documents:create",
      tag: WS_METHODS.taskDocumentsCreate,
    }),
    defaultFolder: createEnvironmentRpcCommand(runtime, {
      label: "task-documents:default-folder",
      tag: WS_METHODS.taskDocumentsDefaultFolder,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "task-documents:open",
      tag: WS_METHODS.taskDocumentsOpen,
    }),
    list: createEnvironmentRpcCommand(runtime, {
      label: "task-documents:list",
      tag: WS_METHODS.taskDocumentsList,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "task-documents:save",
      tag: WS_METHODS.taskDocumentsSave,
    }),
    readRecovery: createEnvironmentRpcCommand(runtime, {
      label: "task-documents:read-recovery",
      tag: WS_METHODS.taskDocumentsReadRecovery,
    }),
    launch: createEnvironmentRpcCommand(runtime, {
      label: "task-documents:launch",
      tag: ORCHESTRATION_V2_WS_METHODS.launchThread,
    }),
    catalogueChanges: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "task-documents:catalogue",
      tag: WS_METHODS.taskDocumentsSubscribeCatalogue,
      idleTtlMs: 0,
      // A revision per notice: repeat notices are equal values the atom would drop.
      transform: (stream) => {
        let revision = 0;
        return Stream.concat(Stream.succeed(null), stream).pipe(Stream.map(() => ++revision));
      },
    }),
    documentChanges: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "task-documents:document",
      tag: WS_METHODS.taskDocumentsSubscribeDocument,
      idleTtlMs: 0,
    }),
  };
}
