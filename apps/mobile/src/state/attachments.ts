import { createAttachmentEnvironmentAtoms } from "@t3tools/client-runtime/state/attachments";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { readEnvironmentScope } from "./session";

function requireAttachmentWriteAccess<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
): AtomCommand<W, A, E | Error> {
  return {
    ...command,
    run: async (registry, input) => {
      if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) {
        return AsyncResult.failure(
          Cause.fail(new Error("This connection cannot change attachments.")),
        );
      }
      return command.run(registry, input);
    },
  };
}

const commands = createAttachmentEnvironmentAtoms(connectionAtomRuntime);
export const attachmentEnvironment = {
  createUploadUrl: requireAttachmentWriteAccess(commands.createUploadUrl),
  remove: requireAttachmentWriteAccess(commands.remove),
};
