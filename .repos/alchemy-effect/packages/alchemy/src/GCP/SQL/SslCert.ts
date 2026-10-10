import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { ALCHEMY_LABEL_PREFIX } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { recoverIfInstanceMissing, waitForSqlOperation } from "./operations.ts";

const MAX_COMMON_NAME_LENGTH = 64;

export type SslCertProps = {
  /**
   * Cloud SQL instance id (the `{instance}` segment of
   * `projects/{project}/instances/{instance}`). Full resource names are
   * accepted and reduced to the last path segment. Immutable — changing
   * it replaces the certificate.
   */
  instance: string;
  /**
   * Common name used to identify the client certificate. If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Must be distinct from other certificates on the instance. Constrained
   * to letters, digits, dots, hyphens, underscores, and spaces. Immutable
   * — changing it replaces the certificate.
   */
  commonName?: string;
};

export type SslCert = Resource<
  "GCP.SQL.SslCert",
  SslCertProps,
  {
    /** Common name used to identify the client certificate. */
    commonName: string;
    /** Cloud SQL instance id. */
    instance: string;
    /** Project id. */
    project: string;
    /** SHA-1 fingerprint; the API id for get/delete. */
    sha1Fingerprint: string;
    /** PEM-encoded client certificate. */
    cert: string | undefined;
    /**
     * PEM-encoded private key. Returned only by insert and persisted in
     * state — subsequent gets omit it.
     */
    privateKey: string | undefined;
    /** Serial number extracted from the certificate. */
    certSerialNumber: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 expiry timestamp. */
    expirationTime: string | undefined;
    /** SQL Admin self-link. */
    selfLink: string | undefined;
    /**
     * PEM-encoded server CA certificate from insert. Subsequent gets omit
     * it, so the value is persisted from the create response.
     */
    serverCaCert: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud SQL client SSL certificate.
 *
 * Insert returns the private key once; it is stored on the resource and
 * cannot be recovered from the API later. Certificates have no labels
 * field. `list` enumerates certs on alchemy-labeled instances so
 * `pnpm nuke:gcp` can find leaked rows. Changing `instance` or
 * `commonName` replaces the certificate. The new certificate is not
 * usable until the instance is restarted.
 *
 * ### Creating a Certificate
 * **Example:** Generated common name on a Cloud SQL instance
 * ```typescript
 * const instance = yield* GCP.SQL.Instance("AppDb", {
 *   tier: "db-f1-micro",
 *   backupEnabled: false,
 * });
 * const cert = yield* GCP.SQL.SslCert("Client", {
 *   instance: instance.instanceName,
 * });
 * ```
 *
 * **Example:** Explicit common name
 * ```typescript
 * const cert = yield* GCP.SQL.SslCert("Client", {
 *   instance: instance.instanceName,
 *   commonName: "app-client",
 * });
 * ```
 *
 * @resource
 * @category SQL
 */
export const SslCert = Resource<SslCert>("GCP.SQL.SslCert");

export class SslCertNotResolved extends Data.TaggedError(
  "GCP.SQL.SslCertNotResolved",
)<{
  instance: string;
  sha1Fingerprint: string;
}> {}

export class SslCertStillExists extends Data.TaggedError(
  "GCP.SQL.SslCertStillExists",
)<{
  instance: string;
  sha1Fingerprint: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const instanceIdOf = (value: string) => lastSegment(value);

const hasAlchemyInstanceLabels = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

const sanitizeCommonName = (name: string) => {
  const mapped = name.replace(
    /[0-9]/g,
    (digit) => "abcdefghij"[Number(digit)] ?? "a",
  );
  let next = mapped.replace(/[^a-zA-Z.\-_ ]/g, "-").replace(/[-\s]+/g, "-");
  next = next.replace(/^[-. ]+|[-. ]+$/g, "");
  if (!/^[a-zA-Z]/.test(next)) next = `c${next}`;
  next = next.slice(0, MAX_COMMON_NAME_LENGTH).replace(/[-. ]+$/g, "");
  return next.length > 0 ? next : "cert";
};

const toCommonName = (
  id: string,
  commonName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (commonName !== undefined) return commonName;
    if (existing !== undefined) return existing;
    return sanitizeCommonName(
      yield* createPhysicalName({
        id,
        maxLength: MAX_COMMON_NAME_LENGTH,
        lowercase: true,
        delimiter: "-",
      }),
    );
  });

type SslCertSecrets = {
  privateKey?: string;
  serverCaCert?: string;
};

const toAttrs = (
  cert: sqladmin.SslCert,
  project: string,
  instance: string,
  secrets?: SslCertSecrets,
) => ({
  commonName: cert.commonName ?? "",
  instance: cert.instance ?? instance,
  project,
  sha1Fingerprint: cert.sha1Fingerprint ?? "",
  cert: cert.cert,
  privateKey: secrets?.privateKey,
  certSerialNumber: cert.certSerialNumber,
  createTime: cert.createTime,
  expirationTime: cert.expirationTime,
  selfLink: cert.selfLink,
  serverCaCert: secrets?.serverCaCert,
});

const getByFingerprint = (
  project: string,
  instance: string,
  sha1Fingerprint: string,
) =>
  sha1Fingerprint.length === 0
    ? Effect.succeed(undefined)
    : sqladmin.getSslCerts({ project, instance, sha1Fingerprint }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        recoverIfInstanceMissing(project, instance, () => undefined),
      );

const findByCommonName = (
  project: string,
  instance: string,
  commonName: string,
) =>
  commonName.length === 0
    ? Effect.succeed(undefined)
    : sqladmin.listSslCerts({ project, instance }).pipe(
        Effect.map((page) =>
          (page.items ?? []).find((cert) => cert.commonName === commonName),
        ),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        recoverIfInstanceMissing(project, instance, () => undefined),
      );

const observe = (
  project: string,
  instance: string,
  sha1Fingerprint: string | undefined,
  commonName: string,
) =>
  Effect.gen(function* () {
    if (sha1Fingerprint !== undefined && sha1Fingerprint.length > 0) {
      const byFingerprint = yield* getByFingerprint(
        project,
        instance,
        sha1Fingerprint,
      );
      if (byFingerprint !== undefined) return byFingerprint;
    }
    return yield* findByCommonName(project, instance, commonName);
  });

const waitForOperation = (
  project: string,
  operation: sqladmin.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForSqlOperation(project, operation, {
    budget: "10 minutes",
    notFoundOk: options?.notFoundOk,
  });

const waitUntilExists = (
  project: string,
  instance: string,
  sha1Fingerprint: string,
) =>
  getByFingerprint(project, instance, sha1Fingerprint).pipe(
    Effect.flatMap((cert) =>
      cert
        ? Effect.succeed(cert)
        : Effect.fail(new SslCertNotResolved({ instance, sha1Fingerprint })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.SslCertNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  project: string,
  instance: string,
  sha1Fingerprint: string,
) =>
  getByFingerprint(project, instance, sha1Fingerprint).pipe(
    Effect.flatMap((cert) =>
      cert === undefined
        ? Effect.void
        : Effect.fail(new SslCertStillExists({ instance, sha1Fingerprint })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.SslCertStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const SslCertProvider = () =>
  Provider.succeed(SslCert, {
    stables: [
      "commonName",
      "instance",
      "project",
      "sha1Fingerprint",
      "selfLink",
      "privateKey",
      "serverCaCert",
      "certSerialNumber",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousInstance = olds?.instance ?? output?.instance;
      const nextInstance = news.instance;
      const previousName = olds?.commonName ?? output?.commonName;
      const nextName = news.commonName ?? previousName;
      const instanceChanged =
        previousInstance !== undefined &&
        instanceIdOf(previousInstance) !== instanceIdOf(nextInstance);
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      if (!instanceChanged && !nameChanged) return undefined;
      return {
        action: "replace" as const,
        deleteFirst: false,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instance = instanceIdOf(olds?.instance ?? output?.instance ?? "");
      if (instance.length === 0) return undefined;
      const commonName = yield* toCommonName(
        id,
        olds?.commonName,
        output?.commonName,
      );
      const existing = yield* observe(
        env.project,
        instance,
        output?.sha1Fingerprint,
        commonName,
      );
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project, instance, {
        privateKey: output?.privateKey,
        serverCaCert: output?.serverCaCert,
      });
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = yield* sqladmin.listInstances
          .items({
            project: env.project,
            maxResults: 1000,
            filter: "instanceType:CLOUD_SQL_INSTANCE",
          })
          .pipe(
            Stream.filter((instance) =>
              hasAlchemyInstanceLabels(instance.settings?.userLabels),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as sqladmin.DatabaseInstance[]),
            ),
          );
        const pages = yield* Effect.forEach(
          instances,
          (instance) => {
            const instanceName = instance.name;
            if (instanceName === undefined || instanceName.length === 0) {
              return Effect.succeed([] as SslCert["Attributes"][]);
            }
            return sqladmin
              .listSslCerts({
                project: env.project,
                instance: instanceName,
              })
              .pipe(
                Effect.map((page) =>
                  (page.items ?? []).map((cert) =>
                    toAttrs(cert, env.project, instanceName),
                  ),
                ),
                // The instance may be deleted mid-listing.
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as SslCert["Attributes"][]),
                ),
                recoverIfInstanceMissing(
                  env.project,
                  instanceName,
                  () => [] as SslCert["Attributes"][],
                ),
              );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instance = instanceIdOf(news.instance);
      const commonName = yield* toCommonName(
        id,
        news.commonName,
        output?.commonName,
      );

      let current = yield* observe(
        env.project,
        instance,
        output?.sha1Fingerprint,
        commonName,
      );
      let secrets: SslCertSecrets = {
        privateKey: output?.privateKey,
        serverCaCert: output?.serverCaCert,
      };

      if (current === undefined) {
        const inserted = yield* sqladmin
          .insertSslCerts({
            project: env.project,
            instance,
            body: { commonName },
          })
          .pipe(
            Effect.tap((response) =>
              response.operation
                ? waitForOperation(env.project, response.operation)
                : Effect.void,
            ),
            Effect.catchTag("Conflict", (error) =>
              findByCommonName(env.project, instance, commonName).pipe(
                Effect.flatMap((existing) =>
                  existing ? Effect.succeed(undefined) : Effect.fail(error),
                ),
              ),
            ),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );

        if (inserted !== undefined) {
          secrets = {
            privateKey:
              inserted.clientCert?.certPrivateKey ?? secrets.privateKey,
            serverCaCert: inserted.serverCaCert?.cert ?? secrets.serverCaCert,
          };
          const fingerprint =
            inserted.clientCert?.certInfo?.sha1Fingerprint ?? "";
          current =
            inserted.clientCert?.certInfo ??
            (fingerprint.length > 0
              ? yield* waitUntilExists(env.project, instance, fingerprint)
              : yield* findByCommonName(env.project, instance, commonName));
        } else {
          current = yield* findByCommonName(env.project, instance, commonName);
        }
      }

      if (
        current === undefined ||
        (current.sha1Fingerprint ?? "").length === 0
      ) {
        return yield* new SslCertNotResolved({
          instance,
          sha1Fingerprint: current?.sha1Fingerprint ?? "",
        });
      }

      if ((current.cert ?? "").length === 0) {
        current = yield* waitUntilExists(
          env.project,
          instance,
          current.sha1Fingerprint ?? "",
        );
      }

      return toAttrs(current, env.project, instance, secrets);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const project = output.project;
      const instance = instanceIdOf(output.instance);
      let sha1Fingerprint = output.sha1Fingerprint;
      if (sha1Fingerprint.length === 0) {
        const existing = yield* findByCommonName(
          project,
          instance,
          output.commonName || olds.commonName || "",
        );
        sha1Fingerprint = existing?.sha1Fingerprint ?? "";
      }
      if (sha1Fingerprint.length === 0) return;
      yield* sqladmin
        .deleteSslCerts({
          project,
          instance,
          sha1Fingerprint,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitForOperation(project, operation, { notFoundOk: true }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          recoverIfInstanceMissing(project, instance, () => undefined),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      yield* waitUntilGone(project, instance, sha1Fingerprint);
    }),
  });
