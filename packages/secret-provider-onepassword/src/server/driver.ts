import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/process";

import { definition, type OnePasswordAccount } from "../shared/definition.ts";

const ONE_PASSWORD_BINARY = "op";
// Bounds a read long enough to reach for a fingerprint reader, short enough not to wedge a rebuild.
const READ_TIMEOUT = Duration.seconds(45);

// `--cache=false` skips the `op daemon`, which hangs on prompts a background server cannot show.
const runOnePassword = Effect.fn("OnePasswordDriver.runOnePassword")(function* (
  args: ReadonlyArray<string>,
) {
  const spawnCommand = yield* resolveSpawnCommand(ONE_PASSWORD_BINARY, ["--cache=false", ...args]);
  return yield* spawnAndCollect(
    ONE_PASSWORD_BINARY,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, { shell: spawnCommand.shell }),
  );
});

// A secret is passed on verbatim; surrounding whitespace can be part of it.
const nonEmpty = (value: string) => (value.trim().length > 0 ? value : undefined);

const readOne = Effect.fn("OnePasswordDriver.readOne")(function* (
  account: OnePasswordAccount,
  reference: string,
) {
  const result = yield* runOnePassword(["read", `--account=${account}`, "--no-newline", reference]);
  if (result.code !== 0) {
    yield* Effect.logWarning("Could not read secret from 1Password", {
      stage: "read",
      exitCode: result.code,
    });
    return undefined;
  }
  return nonEmpty(result.stdout);
});

// One `op inject` costs one unlock for every reference in the template. `op` ignores piped stdin
// from Node, so the template goes through a temp file. A random separator after every reference
// keeps one secret from shifting the others, and leaves any trailing newline outside the values.
const readTogether = Effect.fn("OnePasswordDriver.readTogether")(function* (
  account: OnePasswordAccount,
  references: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const separator = `__t3-secret-${yield* (yield* Crypto.Crypto).randomUUIDv4()}__`;
  const templatePath = yield* fileSystem.makeTempFileScoped({ prefix: "t3code-op-inject-" });
  yield* fileSystem.writeFileString(
    templatePath,
    references.map((reference) => `{{ ${reference} }}${separator}`).join(""),
  );
  const result = yield* runOnePassword(["inject", `--account=${account}`, "-i", templatePath]);
  const values = result.stdout.split(separator);
  const trailing = values.pop();
  if (
    result.code !== 0 ||
    values.length !== references.length ||
    trailing === undefined ||
    trailing.trim().length > 0
  ) {
    yield* Effect.logWarning("Could not batch-read secrets from 1Password", {
      stage: "inject",
      exitCode: result.code,
      references: references.length,
    });
    return undefined;
  }
  return values.map(nonEmpty);
}, Effect.scoped);

/** `None` when 1Password did not answer in time; a failed run reads as `Some(undefined)`. */
const bounded = <A, E extends { readonly _tag: string }, R>(
  stage: "read" | "inject",
  effect: Effect.Effect<A | undefined, E, R>,
) =>
  effect.pipe(
    Effect.timeoutOption(READ_TIMEOUT),
    Effect.tap((outcome) =>
      Option.isNone(outcome)
        ? Effect.logWarning("1Password did not answer in time", { stage })
        : Effect.void,
    ),
    Effect.catch((error) =>
      Effect.logWarning("Could not run 1Password", { stage, error: error._tag }).pipe(
        Effect.as(Option.some(undefined)),
      ),
    ),
  );

export const driver = defineSecretProviderDriver({
  kind: definition.kind,
  definition,
  read: Effect.fn("OnePasswordDriver.read")(function* ({ account }, references) {
    if (references.length > 1) {
      const together = yield* bounded("inject", readTogether(account, references));
      // Reading one by one after a timeout would only wait that long again for each reference.
      if (Option.isNone(together)) return references.map(() => undefined);
      if (together.value !== undefined) return together.value;
    }
    return yield* Effect.forEach(references, (reference) =>
      bounded("read", readOne(account, reference)).pipe(Effect.map(Option.getOrUndefined)),
    );
  }),
});
