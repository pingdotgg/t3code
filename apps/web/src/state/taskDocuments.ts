import { createTaskDocumentEnvironmentAtoms } from "@t3tools/client-runtime/state/task-documents";
import * as Schema from "effect/Schema";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";

export const taskDocumentEnvironment = createTaskDocumentEnvironmentAtoms(connectionAtomRuntime);

const updateInstructionsKey = (environmentId: EnvironmentId) =>
  `t3code:task-update-instructions:${environmentId}`;

/** A path on the environment's own machine, so each environment remembers its own. */
export const readTaskUpdateInstructionsPath = (environmentId: EnvironmentId) =>
  getLocalStorageItem(updateInstructionsKey(environmentId), Schema.String)?.trim() || null;

export const writeTaskUpdateInstructionsPath = (environmentId: EnvironmentId, path: string) =>
  setLocalStorageItem(updateInstructionsKey(environmentId), path.trim(), Schema.String);
