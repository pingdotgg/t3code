import { BadArgument, SystemError } from "effect/PlatformError";
import * as Stream from "effect/Stream";
import {
  collectRedactedSecrets,
  redactionMarker,
  redactStream,
  redactText,
} from "../Util/Redaction.ts";
import type { CommandProps } from "./Command.ts";

export interface CommandRedactor {
  readonly redact: (value: string) => string;
  readonly stream: <E, R>(stream: Stream.Stream<string, E, R>) => Stream.Stream<string, E, R>;
}

/** Redacts the `Redacted` env values of a command from its output and errors. */
export const makeCommandRedactor = (env: CommandProps["env"]): CommandRedactor => {
  const secrets = collectRedactedSecrets(env ?? {});
  const marker = redactionMarker(secrets, "[REDACTED]");
  return {
    redact: (value) => redactText(value, secrets, marker),
    stream: (stream) => redactStream(stream, secrets, marker),
  };
};

export const redactPlatformReason = (
  reason: BadArgument | SystemError,
  redactor: CommandRedactor,
): BadArgument | SystemError => {
  if (reason instanceof BadArgument) {
    return new BadArgument({
      module: redactor.redact(reason.module),
      method: redactor.redact(reason.method),
      description:
        reason.description === undefined ? undefined : redactor.redact(reason.description),
    });
  }

  return new SystemError({
    _tag: reason._tag,
    module: redactor.redact(reason.module),
    method: redactor.redact(reason.method),
    description: reason.description === undefined ? undefined : redactor.redact(reason.description),
    syscall: reason.syscall === undefined ? undefined : redactor.redact(reason.syscall),
    pathOrDescriptor:
      typeof reason.pathOrDescriptor === "string"
        ? redactor.redact(reason.pathOrDescriptor)
        : reason.pathOrDescriptor,
  });
};
