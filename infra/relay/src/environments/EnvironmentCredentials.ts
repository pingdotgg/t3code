import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { and, eq, isNull, ne, notExists } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayEnvironmentCredentials, relayEnvironmentLinks } from "../persistence/schema.ts";

export class EnvironmentCredentialCreatePersistenceError extends Schema.TaggedErrorClass<EnvironmentCredentialCreatePersistenceError>()(
  "EnvironmentCredentialCreatePersistenceError",
  {
    stage: Schema.Literals([
      "generate-credential",
      "hash-token",
      "insert-credential",
      "revoke-previous-credentials",
    ]),
    environmentId: Schema.String,
    credentialId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment credential creation failed during '${this.stage}' for environment '${this.environmentId}'${this.credentialId === undefined ? "" : `, credential '${this.credentialId}'`}`;
  }
}

export class EnvironmentCredentialAuthenticatePersistenceError extends Schema.TaggedErrorClass<EnvironmentCredentialAuthenticatePersistenceError>()(
  "EnvironmentCredentialAuthenticatePersistenceError",
  {
    stage: Schema.Literals(["hash-token", "lookup-credential"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment credential authentication failed during '${this.stage}'`;
  }
}

export class EnvironmentCredentialRevokePersistenceError extends Schema.TaggedErrorClass<EnvironmentCredentialRevokePersistenceError>()(
  "EnvironmentCredentialRevokePersistenceError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke credentials for environment '${this.environmentId}'`;
  }
}

export interface EnvironmentCredentialPrincipal {
  readonly credentialId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}

export class EnvironmentCredentials extends Context.Service<
  EnvironmentCredentials,
  {
    readonly create: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<string, EnvironmentCredentialCreatePersistenceError>;
    readonly authenticate: (
      token: string,
    ) => Effect.Effect<
      Option.Option<EnvironmentCredentialPrincipal>,
      EnvironmentCredentialAuthenticatePersistenceError
    >;
    readonly revokeForEnvironmentPublicKey: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<boolean, EnvironmentCredentialRevokePersistenceError>;
  }
>()("t3code-relay/environments/EnvironmentCredentials") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;
  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(Encoding.encodeBase64Url));
  const randomTokenPart = (segments: number) =>
    Effect.map(Effect.all(Array.from({ length: segments }, () => crypto.randomUUIDv4)), (values) =>
      values.join("").replaceAll("-", ""),
    );
  const makeCredential = Effect.fnUntraced(function* () {
    const credentialId = yield* randomTokenPart(2);
    const secret = yield* randomTokenPart(3);
    return {
      credentialId,
      token: `t3env_${credentialId}_${secret}`,
    };
  });

  return EnvironmentCredentials.of({
    create: Effect.fn("relay.environment_credentials.create")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      const credential = yield* makeCredential().pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentCredentialCreatePersistenceError({
              stage: "generate-credential",
              environmentId: input.environmentId,
              cause,
            }),
        ),
      );
      const credentialHash = yield* hashToken(credential.token).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentCredentialCreatePersistenceError({
              stage: "hash-token",
              environmentId: input.environmentId,
              credentialId: credential.credentialId,
              cause,
            }),
        ),
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .insert(relayEnvironmentCredentials)
        .values({
          credentialId: credential.credentialId,
          environmentId: input.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          credentialHash,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialCreatePersistenceError({
                stage: "insert-credential",
                environmentId: input.environmentId,
                credentialId: credential.credentialId,
                cause,
              }),
          ),
        );
      yield* db
        .update(relayEnvironmentCredentials)
        .set({
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(relayEnvironmentCredentials.environmentId, input.environmentId),
            eq(relayEnvironmentCredentials.environmentPublicKey, input.environmentPublicKey),
            ne(relayEnvironmentCredentials.credentialId, credential.credentialId),
            isNull(relayEnvironmentCredentials.revokedAt),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialCreatePersistenceError({
                stage: "revoke-previous-credentials",
                environmentId: input.environmentId,
                credentialId: credential.credentialId,
                cause,
              }),
          ),
        );
      return credential.token;
    }),

    authenticate: Effect.fn("relay.environment_credentials.authenticate")(function* (token) {
      const credentialHash = yield* hashToken(token).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentCredentialAuthenticatePersistenceError({
              stage: "hash-token",
              cause,
            }),
        ),
      );
      const rows = yield* db
        .select({
          credentialId: relayEnvironmentCredentials.credentialId,
          environmentId: relayEnvironmentCredentials.environmentId,
          environmentPublicKey: relayEnvironmentCredentials.environmentPublicKey,
        })
        .from(relayEnvironmentCredentials)
        .where(
          and(
            eq(relayEnvironmentCredentials.credentialHash, credentialHash),
            isNull(relayEnvironmentCredentials.revokedAt),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialAuthenticatePersistenceError({
                stage: "lookup-credential",
                cause,
              }),
          ),
        );
      const row = rows[0];
      if (row) {
        yield* Effect.annotateCurrentSpan({ "relay.environment_id": row.environmentId });
      }
      return row
        ? Option.some({
            credentialId: row.credentialId,
            environmentId: row.environmentId,
            environmentPublicKey: row.environmentPublicKey,
          })
        : Option.none();
    }),

    revokeForEnvironmentPublicKey: Effect.fn(
      "relay.environment_credentials.revoke_for_environment_public_key",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayEnvironmentCredentials)
        .set({
          revokedAt,
          updatedAt: revokedAt,
        })
        .where(
          and(
            eq(relayEnvironmentCredentials.environmentId, input.environmentId),
            eq(relayEnvironmentCredentials.environmentPublicKey, input.environmentPublicKey),
            isNull(relayEnvironmentCredentials.revokedAt),
            notExists(
              db
                .select({ userId: relayEnvironmentLinks.userId })
                .from(relayEnvironmentLinks)
                .where(
                  and(
                    eq(relayEnvironmentLinks.environmentId, input.environmentId),
                    eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
                    isNull(relayEnvironmentLinks.revokedAt),
                  ),
                ),
            ),
          ),
        )
        .returning({
          credentialId: relayEnvironmentCredentials.credentialId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialRevokePersistenceError({
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),
  });
});

export const layer = Layer.effect(EnvironmentCredentials, make);
