import {
  AuthEnvironmentScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const DEFAULT_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
] as const satisfies ReadonlyArray<AuthEnvironmentScope>;
const DUMMY_SALT = Buffer.from("t3-self-hosted-login-dummy-salt").toString("base64url");
const DUMMY_DERIVED_KEY =
  "xQlcxTBTTUvRp0C7sIa63XuFm6qYkC3qKM0wV0UfsGevEHViNUZ7xFiPIasNLbw_xD_Ib2okWQb4Uh6IvD95iA";
const DUMMY_HASH = `scrypt$16384$8$1$${DUMMY_SALT}$${DUMMY_DERIVED_KEY}`;

const SelfHostedAccountFile = Schema.Struct({
  version: Schema.Literal(1),
  accounts: Schema.Array(
    Schema.Struct({
      username: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
      passwordHash: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
      scopes: Schema.optionalKey(AuthEnvironmentScopes),
      label: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
    }),
  ),
});

export interface SelfHostedAccount {
  readonly username: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label?: string;
}

interface StoredSelfHostedAccount extends SelfHostedAccount {
  readonly passwordHash: string;
}

export class SelfHostedAccountStoreError extends Schema.TaggedErrorClass<SelfHostedAccountStoreError>()(
  "SelfHostedAccountStoreError",
  {
    operation: Schema.Literals(["read", "decode", "verify"]),
    path: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class SelfHostedAccountStore extends Context.Service<
  SelfHostedAccountStore,
  {
    readonly enabled: boolean;
    readonly authenticate: (
      username: string,
      password: string,
    ) => Effect.Effect<Option.Option<SelfHostedAccount>, SelfHostedAccountStoreError>;
  }
>()("t3/auth/SelfHostedAccountStore") {}

interface ParsedScryptHash {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
  readonly salt: Buffer;
  readonly derivedKey: Buffer;
}

function parseScryptHash(value: string): ParsedScryptHash | null {
  const [algorithm, costRaw, blockSizeRaw, parallelizationRaw, saltRaw, derivedKeyRaw, ...rest] =
    value.split("$");
  if (
    algorithm !== "scrypt" ||
    !costRaw ||
    !blockSizeRaw ||
    !parallelizationRaw ||
    !saltRaw ||
    !derivedKeyRaw ||
    rest.length > 0
  ) {
    return null;
  }

  const cost = Number(costRaw);
  const blockSize = Number(blockSizeRaw);
  const parallelization = Number(parallelizationRaw);
  if (
    !Number.isSafeInteger(cost) ||
    cost < 2 ||
    cost > 1_048_576 ||
    (cost & (cost - 1)) !== 0 ||
    !Number.isSafeInteger(blockSize) ||
    blockSize < 1 ||
    blockSize > 32 ||
    !Number.isSafeInteger(parallelization) ||
    parallelization < 1 ||
    parallelization > 32
  ) {
    return null;
  }

  try {
    const salt = Buffer.from(saltRaw, "base64url");
    const derivedKey = Buffer.from(derivedKeyRaw, "base64url");
    if (salt.length < 16 || derivedKey.length < 32 || derivedKey.length > 128) {
      return null;
    }
    return { cost, blockSize, parallelization, salt, derivedKey };
  } catch {
    return null;
  }
}

const verifyScrypt = Effect.fn("SelfHostedAccountStore.verifyScrypt")(function* (
  password: string,
  passwordHash: string,
) {
  const parsed = parseScryptHash(passwordHash);
  if (parsed === null) {
    return false;
  }
  const actual = yield* Effect.tryPromise({
    try: () =>
      new Promise<Buffer>((resolve, reject) => {
        nodeScrypt(
          password,
          parsed.salt,
          parsed.derivedKey.length,
          {
            N: parsed.cost,
            r: parsed.blockSize,
            p: parsed.parallelization,
            maxmem: Math.max(32 * 1024 * 1024, 256 * parsed.cost * parsed.blockSize),
          },
          (error, result) => (error ? reject(error) : resolve(result)),
        );
      }),
    catch: (cause) => new SelfHostedAccountStoreError({ operation: "verify", cause }),
  });
  return actual.length === parsed.derivedKey.length && timingSafeEqual(actual, parsed.derivedKey);
});

export const layer = Layer.effect(
  SelfHostedAccountStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = config.selfHostedAccountsFile;
    if (path === undefined) {
      return SelfHostedAccountStore.of({
        enabled: false,
        authenticate: (_username, password) =>
          verifyScrypt(password, DUMMY_HASH).pipe(Effect.as(Option.none())),
      });
    }

    const contents = yield* fileSystem
      .readFileString(path)
      .pipe(
        Effect.mapError(
          (cause) => new SelfHostedAccountStoreError({ operation: "read", path, cause }),
        ),
      );
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SelfHostedAccountFile))(
      contents,
    ).pipe(
      Effect.mapError(
        (cause) => new SelfHostedAccountStoreError({ operation: "decode", path, cause }),
      ),
    );
    const accounts = new Map<string, StoredSelfHostedAccount>();
    for (const candidate of decoded.accounts) {
      const username = candidate.username.trim();
      if (
        username.length === 0 ||
        accounts.has(username) ||
        parseScryptHash(candidate.passwordHash) === null
      ) {
        return yield* new SelfHostedAccountStoreError({
          operation: "decode",
          path,
          cause: new Error("Account usernames must be unique and password hashes must be valid."),
        });
      }
      accounts.set(username, {
        username,
        passwordHash: candidate.passwordHash,
        scopes: candidate.scopes ?? DEFAULT_SCOPES,
        ...(candidate.label === undefined ? {} : { label: candidate.label.trim() }),
      });
    }

    return SelfHostedAccountStore.of({
      enabled: true,
      authenticate: (username, password) => {
        const account = accounts.get(username.trim());
        return verifyScrypt(password, account?.passwordHash ?? DUMMY_HASH).pipe(
          Effect.map((valid) =>
            valid && account !== undefined
              ? Option.some({
                  username: account.username,
                  scopes: account.scopes,
                  ...(account.label === undefined ? {} : { label: account.label }),
                })
              : Option.none(),
          ),
        );
      },
    });
  }),
);
