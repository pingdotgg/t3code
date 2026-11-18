import type { BrowserLoginField } from "@t3tools/contracts";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import {
  defineSecretProviderDriver,
  SecretProviderLoginsError,
  type SecretProviderLogin,
  type SecretProviderLoginDetail,
} from "@t3tools/secret-provider-core/server/driver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
  const separator = `__t3-secret-${yield* (yield* SecureRandom.SecureRandom).uuidV4()}__`;
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

const recover = <A, E extends { readonly _tag: string }, R>(
  stage: "read" | "inject",
  effect: Effect.Effect<A | undefined, E, R>,
) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not run 1Password", { stage, error: error._tag }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

// Only these keys are decoded; every field `value`, `totp`, and `additional_information` is dropped.
const OpLoginSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  category: Schema.String,
  urls: Schema.optional(Schema.Array(Schema.Struct({ href: Schema.String }))),
});
const OpLoginItem = Schema.Struct({
  ...OpLoginSummary.fields,
  vault: Schema.Struct({ id: Schema.String }),
  fields: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        type: Schema.optional(Schema.String),
        purpose: Schema.optional(Schema.String),
      }),
    ),
  ),
});
// A parse error can quote the output, so it is never logged or returned.
const decodeLoginList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(OpLoginSummary)),
);
const decodeLoginItem = Schema.decodeUnknownOption(Schema.fromJsonString(OpLoginItem));
const decodeVaults = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))),
);
const ITEM_ID = /^[A-Za-z0-9]{1,64}$/;

const summaryOf = (item: typeof OpLoginSummary.Type): SecretProviderLogin => ({
  id: item.id,
  title: item.title,
  urls: (item.urls ?? []).map((url) => url.href),
});

/** Reads only which fields exist, by purpose and type; a label can say anything. */
const loginDetail = (output: string): SecretProviderLoginDetail | undefined => {
  const decoded = decodeLoginItem(output);
  if (Option.isNone(decoded) || decoded.value.category !== "LOGIN") return undefined;
  const item = decoded.value;
  const reference = (fieldId: string, query = "") => {
    const candidate = `op://${item.vault.id}/${item.id}/${fieldId}${query}`;
    return definition.isReference(candidate) ? candidate : undefined;
  };
  const itemFields = item.fields ?? [];
  const username = itemFields.find((field) => field.purpose === "USERNAME");
  const password = itemFields.find((field) => field.purpose === "PASSWORD");
  const otp = itemFields.find((field) => field.type === "OTP");
  const fields: Partial<Record<BrowserLoginField, string>> = {};
  const usernameReference = username && reference(username.id);
  const passwordReference = password && reference(password.id);
  const otpReference = otp && reference(otp.id, "?attribute=otp");
  if (usernameReference) fields.username = usernameReference;
  if (passwordReference) fields.password = passwordReference;
  if (otpReference) fields.otp = otpReference;
  return { ...summaryOf(item), fields };
};

const loginSummaries = (output: string): ReadonlyArray<SecretProviderLogin> | undefined => {
  const decoded = decodeLoginList(output);
  return Option.isNone(decoded)
    ? undefined
    : decoded.value.filter((item) => item.category === "LOGIN").map(summaryOf);
};

const loginsFailure = (
  stage: "vault list" | "item list" | "item get",
  result: { code: number; stderr: string },
) =>
  Effect.logWarning("Could not list logins from 1Password", {
    stage,
    exitCode: result.code,
  }).pipe(
    Effect.andThen(
      Effect.fail(
        new SecretProviderLoginsError({
          reason: /isn't a vault/.test(result.stderr)
            ? "vaultNotFound"
            : /isn't an item/.test(result.stderr)
              ? "itemNotFound"
              : "unavailable",
        }),
      ),
    ),
  );

const runForLogins = (args: ReadonlyArray<string>) =>
  runOnePassword(args).pipe(
    Effect.timeoutOption(READ_TIMEOUT),
    Effect.catch((error) =>
      Effect.logWarning("Could not run 1Password", { stage: args[0], error: error._tag }).pipe(
        Effect.as(Option.none()),
      ),
    ),
    Effect.flatMap(Effect.fromOption),
    Effect.mapError(() => new SecretProviderLoginsError({ reason: "unavailable" })),
  );

const listVaults = Effect.fn("OnePasswordDriver.listVaults")(function* (
  account: OnePasswordAccount,
) {
  // `op` uses 1Password Connect when this is set, and through Connect it cannot list vaults.
  const connectHost = yield* Config.String("OP_CONNECT_HOST").pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isSome(connectHost) && connectHost.value.trim() !== "") return Option.none();
  const result = yield* runForLogins(["vault", "list", `--account=${account}`, "--format=json"]);
  if (result.code !== 0) return yield* loginsFailure("vault list", result);
  const vaults = decodeVaults(result.stdout);
  if (Option.isNone(vaults)) return yield* loginsFailure("vault list", { code: 0, stderr: "" });
  return Option.some(vaults.value.map(({ id, name }) => ({ id, name })));
});

const listLogins = Effect.fn("OnePasswordDriver.listLogins")(function* (
  account: OnePasswordAccount,
  vault: string,
) {
  const result = yield* runForLogins([
    "item",
    "list",
    `--account=${account}`,
    `--vault=${vault}`,
    "--categories=Login",
    "--format=json",
  ]);
  if (result.code !== 0) return yield* loginsFailure("item list", result);
  const logins = loginSummaries(result.stdout);
  if (logins === undefined) return yield* loginsFailure("item list", { code: 0, stderr: "" });
  return logins;
});

const getLogin = Effect.fn("OnePasswordDriver.getLogin")(function* (
  account: OnePasswordAccount,
  vault: string,
  itemId: string,
) {
  if (!ITEM_ID.test(itemId)) {
    return yield* new SecretProviderLoginsError({ reason: "itemNotFound" });
  }
  const result = yield* runForLogins([
    "item",
    "get",
    itemId,
    `--account=${account}`,
    `--vault=${vault}`,
    "--format=json",
  ]);
  if (result.code !== 0) return yield* loginsFailure("item get", result);
  const login = loginDetail(result.stdout);
  if (login === undefined || login.id !== itemId) {
    return yield* new SecretProviderLoginsError({ reason: "itemNotFound" });
  }
  return login;
});

export const driver = defineSecretProviderDriver({
  kind: definition.kind,
  definition,
  logins: {
    vaults: ({ account }) => listVaults(account),
    list: ({ account }, vault) => listLogins(account, vault),
    get: ({ account }, vault, itemId) => getLogin(account, vault, itemId),
  },
  read: Effect.fn("OnePasswordDriver.read")(function* ({ account }, references) {
    // One deadline covers the batch and the fallback; a reference not read by then is unreadable.
    const values: Array<string | undefined> = references.map(() => undefined);
    const outcome = yield* Effect.gen(function* () {
      if (references.length > 1) {
        const together = yield* recover("inject", readTogether(account, references));
        if (together !== undefined) return together;
      }
      yield* Effect.forEach(
        references,
        (reference, index) =>
          recover("read", readOne(account, reference)).pipe(
            Effect.map((value) => {
              values[index] = value;
            }),
          ),
        { discard: true },
      );
      return values;
    }).pipe(Effect.timeoutOption(READ_TIMEOUT));
    if (Option.isSome(outcome)) return outcome.value;
    yield* Effect.logWarning("1Password did not answer in time", {
      references: references.length,
    });
    return values;
  }),
});
