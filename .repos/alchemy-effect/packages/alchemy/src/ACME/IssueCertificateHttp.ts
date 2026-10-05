import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "../Output.ts";
import type { Account } from "./Account.ts";
import {
  accountLayer,
  issueCertificate,
  revokeCertificate,
  type AccountCredentials,
} from "./Client.ts";
import {
  IssueCertificate,
  type IssueCertificateClient,
} from "./IssueCertificate.ts";

/**
 * Implementation of {@link IssueCertificate}: the account's directory
 * URL, account URL and private key are bound into the host at deploy time
 * and read back at runtime; every call signs with them over HTTPS.
 *
 * Provide it on the Worker / Service / Action Effect.
 *
 * ### Provide the layer
 * **Example:** On a Fly Service
 * ```typescript
 * Effect.gen(function* () {
 *   const acme = yield* ACME.IssueCertificate(LetsEncrypt);
 *   // ...
 * }).pipe(Effect.provide(ACME.IssueCertificateHttp))
 * ```
 *
 * @layer
 * @product Certificate
 * @provides ACME.IssueCertificate
 */
export const IssueCertificateHttp = Layer.succeed(
  IssueCertificate,
  Effect.fn(function* (account: Account) {
    const directoryUrl = yield* account.directoryUrl;
    const accountUrl = yield* account.accountUrl;
    const trustedRoot = yield* account.trustedRoot.pipe(
      Output.map((root) => root ?? ""),
    );
    const privateKey = yield* account.privateKey;
    const credentials = Effect.all({
      directoryUrl,
      trustedRoot,
      accountUrl,
      privateKey,
    }).pipe(
      Effect.map((bound): AccountCredentials => ({
        ca: {
          directoryUrl: bound.directoryUrl,
          trustedRoot: bound.trustedRoot || undefined,
        },
        accountKey: bound.privateKey,
        accountUrl: bound.accountUrl,
      })),
    );
    const client: IssueCertificateClient = {
      issue: Effect.fn("ACME.IssueCertificate.issue")(function* (request) {
        const creds = yield* credentials;
        return yield* issueCertificate(request).pipe(
          Effect.provide(accountLayer(creds)),
        );
      }),
      revoke: Effect.fn("ACME.IssueCertificate.revoke")(function* (request) {
        const creds = yield* credentials;
        return yield* revokeCertificate(request).pipe(
          Effect.provide(accountLayer(creds)),
        );
      }),
    };
    return client;
  }),
);
