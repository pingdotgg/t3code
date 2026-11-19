import { createAttachmentEnvironmentAtoms } from "@t3tools/client-runtime/state/attachments";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { msg } from "gt-react-native";
import { m } from "../i18n/messages";

import { connectionAtomRuntime } from "../connection/runtime";
import { readEnvironmentScope } from "./session";

function requireAttachmentWriteAccess<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
): AtomCommand<W, A, E | EnvironmentAuthorizationError> {
  return {
    ...command,
    run: (registry, input) =>
      Effect.suspend<A, E | EnvironmentAuthorizationError, never>(() =>
        readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)
          ? command.run(registry, input)
          : Effect.fail(
              new EnvironmentAuthorizationError({
                message: m(msg("This connection cannot change attachments.")),
                requiredScope: AuthOrchestrationOperateScope,
              }),
            ),
      ),
  };
}

const commands = createAttachmentEnvironmentAtoms(connectionAtomRuntime);
export const attachmentEnvironment = {
  createUploadUrl: requireAttachmentWriteAccess(commands.createUploadUrl),
  remove: requireAttachmentWriteAccess(commands.remove),
};
