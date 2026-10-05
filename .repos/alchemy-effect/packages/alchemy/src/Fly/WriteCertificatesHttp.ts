import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { CredentialsFromAmbientOrEnv } from "./Credentials.ts";
import {
  type SecretAuth,
  makeHttpAppBinding,
  unwrapSecretValue,
} from "./SecretHttp.ts";
import {
  WriteCertificates,
  type WriteCertificatesClient,
} from "./WriteCertificates.ts";

/**
 * HTTP implementation of {@link WriteCertificates}. Provide it on the
 * {@link Service} or Action Effect.
 *
 * ### Provide the layer
 * **Example:** On a Service
 * ```typescript
 * Effect.gen(function* () {
 *   const certs = yield* Fly.WriteCertificates(Site);
 *   // ...
 * }).pipe(Effect.provide(Fly.WriteCertificatesHttp))
 * ```
 *
 * @layer
 * @product Certificate
 * @provides Fly.WriteCertificates
 */
export const WriteCertificatesHttp = Layer.effect(
  WriteCertificates,
  Effect.suspend(() =>
    makeHttpAppBinding<WriteCertificatesClient>({
      makeClient: certificatesWriteClient,
    }),
  ),
).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CredentialsFromAmbientOrEnv),
);

/** Build the client over an injectable auth and App name. */
export const certificatesWriteClient = (
  auth: SecretAuth,
  appName: Effect.Effect<string>,
): WriteCertificatesClient => {
  const authorize = auth.authorize;
  return {
    request: Effect.fn("Fly.Certificates.request")(function* (hostname) {
      return yield* authorize(
        machines
          .createAppAcmeCertificate({ app_name: yield* appName, hostname })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined))),
      );
    }),
    upload: Effect.fn("Fly.Certificates.upload")(function* (request) {
      const app_name = yield* appName;
      const body = {
        app_name,
        hostname: request.hostname,
        fullchain: request.fullchain,
        private_key: unwrapSecretValue(request.privateKey),
      };
      return yield* authorize(
        machines.createAppCustomCertificate(body).pipe(
          // An existing custom certificate conflicts: replace it.
          Effect.catchTag("Conflict", () =>
            machines
              .deleteAppCustomCertificate({
                app_name,
                hostname: request.hostname,
              })
              .pipe(
                Effect.catchTag("NotFound", () => Effect.void),
                Effect.andThen(machines.createAppCustomCertificate(body)),
              ),
          ),
        ),
      );
    }),
    check: Effect.fn("Fly.Certificates.check")(function* (hostname) {
      return yield* authorize(
        machines.checkAppCertificate({ app_name: yield* appName, hostname }),
      );
    }),
    get: Effect.fn("Fly.Certificates.get")(function* (hostname) {
      return yield* authorize(
        machines
          .getAppCertificate({ app_name: yield* appName, hostname })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
      );
    }),
    remove: Effect.fn("Fly.Certificates.remove")(function* (hostname) {
      return yield* authorize(
        machines
          .deleteAppCertificate({ app_name: yield* appName, hostname })
          .pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.asVoid,
          ),
      );
    }),
  };
};
