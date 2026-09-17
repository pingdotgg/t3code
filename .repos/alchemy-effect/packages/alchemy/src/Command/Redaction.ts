import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { BadArgument, SystemError } from "effect/PlatformError";
import type { CommandProps } from "./Command.ts";

const DEFAULT_REDACTION_MARKER = "[REDACTED]";

export interface CommandRedactor {
  readonly redact: (value: string) => string;
  readonly stream: <E, R>(
    stream: Stream.Stream<string, E, R>,
  ) => Stream.Stream<string, E, R>;
}

const redactedValues = (env: CommandProps["env"]): ReadonlyArray<string> =>
  [
    ...new Set(
      Object.values(env ?? {})
        .filter((value): value is Redacted.Redacted<string> =>
          Redacted.isRedacted(value),
        )
        .map(Redacted.value)
        .filter((value) => value.length > 0),
    ),
  ].sort((left, right) => right.length - left.length);

const redactionMarker = (secrets: ReadonlyArray<string>): string => {
  if (!secrets.some((secret) => DEFAULT_REDACTION_MARKER.includes(secret))) {
    return DEFAULT_REDACTION_MARKER;
  }

  // The usual marker can itself be a secret (or contain a very short secret).
  // Pick a single private-use character absent from every secret so replacing
  // a value can never reproduce that exact value in output.
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint++) {
    const candidate = String.fromCodePoint(codePoint);
    if (secrets.every((secret) => !secret.includes(candidate))) {
      return candidate;
    }
  }

  // An env value containing the entire private-use block is pathological, but
  // a supplementary private-use code point still gives us a safe marker.
  for (let codePoint = 0xf0000; codePoint <= 0xffffd; codePoint++) {
    const candidate = String.fromCodePoint(codePoint);
    if (secrets.every((secret) => !secret.includes(candidate))) {
      return candidate;
    }
  }

  // This requires a secret larger than the full private-use character space.
  // Keeping an empty replacement is safer than reproducing any part of it.
  return "";
};

const redact = (
  value: string,
  secrets: ReadonlyArray<string>,
  marker: string,
): string =>
  secrets.reduce((safe, secret) => safe.split(secret).join(marker), value);

/**
 * Redact a text stream without leaking secrets split across chunk boundaries.
 * The pending suffix is always the longest suffix that could still grow into
 * one of the configured secrets. Complete matches are replaced before any
 * text is emitted.
 */
const redactStream = <E, R>(
  stream: Stream.Stream<string, E, R>,
  secrets: ReadonlyArray<string>,
  marker: string,
): Stream.Stream<string, E, R> => {
  if (secrets.length === 0) return stream;

  return stream.pipe(
    Stream.mapAccum(
      () => "",
      (pending, chunk) => {
        let remaining = pending + chunk;
        let output = "";

        while (remaining.length > 0) {
          let matchIndex = -1;
          let match: string | undefined;
          for (const secret of secrets) {
            const index = remaining.indexOf(secret);
            if (
              index >= 0 &&
              (matchIndex < 0 ||
                index < matchIndex ||
                (index === matchIndex && secret.length > (match?.length ?? 0)))
            ) {
              matchIndex = index;
              match = secret;
            }
          }

          if (match !== undefined) {
            output += remaining.slice(0, matchIndex) + marker;
            remaining = remaining.slice(matchIndex + match.length);
            continue;
          }

          let suffixLength = 0;
          for (const secret of secrets) {
            const candidateLength = Math.min(
              secret.length - 1,
              remaining.length,
            );
            for (
              let length = candidateLength;
              length > suffixLength;
              length--
            ) {
              if (secret.startsWith(remaining.slice(-length))) {
                suffixLength = length;
                break;
              }
            }
          }

          output += remaining.slice(0, remaining.length - suffixLength);
          remaining = remaining.slice(remaining.length - suffixLength);
          break;
        }

        return [remaining, output.length === 0 ? [] : [output]] as const;
      },
      {
        onHalt: (pending) =>
          pending.length === 0 ? [] : [redact(pending, secrets, marker)],
      },
    ),
  );
};

export const makeCommandRedactor = (
  env: CommandProps["env"],
): CommandRedactor => {
  const secrets = redactedValues(env);
  const marker = redactionMarker(secrets);
  return {
    redact: (value) => redact(value, secrets, marker),
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
        reason.description === undefined
          ? undefined
          : redactor.redact(reason.description),
    });
  }

  return new SystemError({
    _tag: reason._tag,
    module: redactor.redact(reason.module),
    method: redactor.redact(reason.method),
    description:
      reason.description === undefined
        ? undefined
        : redactor.redact(reason.description),
    syscall:
      reason.syscall === undefined
        ? undefined
        : redactor.redact(reason.syscall),
    pathOrDescriptor:
      typeof reason.pathOrDescriptor === "string"
        ? redactor.redact(reason.pathOrDescriptor)
        : reason.pathOrDescriptor,
  });
};
