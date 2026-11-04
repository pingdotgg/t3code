import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Providers } from "../Providers.ts";

export type ServiceAccountKeyProps = {
  /**
   * Email of the service account the key belongs to. Changing it replaces
   * the key.
   */
  serviceAccount: string;
};

export type ServiceAccountKey = Resource<
  "GCP.IAM.ServiceAccountKey",
  ServiceAccountKeyProps,
  {
    /** Full resource name `projects/{project}/serviceAccounts/{email}/keys/{keyId}`. */
    name: string;
    /** Email of the service account the key belongs to. */
    serviceAccount: string;
    /** The key's `private_key_id`. */
    privateKeyId: string;
    /**
     * The key's PKCS #8 PEM private key. Google returns it only when the key
     * is created, so it lives in Alchemy's state.
     */
    privateKey: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

/**
 * A key for a Google Cloud IAM service account, for code that runs outside
 * GCP and has to sign as the account.
 *
 * Prefer running as the service account (Cloud Run, Cloud Functions, GKE
 * Workload Identity) where you can: a key is a long-lived secret. Some
 * organizations block key creation with the
 * `iam.disableServiceAccountKeyCreation` policy.
 *
 * ### Creating a Key
 * **Example:** Key for a service account
 * ```typescript
 * const account = yield* GCP.IAM.ServiceAccount("Ci", {});
 * const key = yield* GCP.IAM.ServiceAccountKey("CiKey", {
 *   serviceAccount: account.email,
 * });
 * ```
 *
 * @resource
 * @category IAM
 */
export const ServiceAccountKey = Resource<ServiceAccountKey>("GCP.IAM.ServiceAccountKey");

export class ServiceAccountKeyInvalid extends Data.TaggedError("GCP.IAM.ServiceAccountKeyInvalid")<{
  resourceName: string;
}> {}

/** The fields of a `TYPE_GOOGLE_CREDENTIALS_FILE` key that callers need. */
const decodeKeyFile = (name: string, privateKeyData: string) =>
  Effect.try({
    try: () => {
      const file = JSON.parse(Buffer.from(privateKeyData, "base64").toString("utf8")) as {
        private_key_id: string;
        private_key: string;
      };
      return { privateKeyId: file.private_key_id, privateKey: Redacted.make(file.private_key) };
    },
    // The cause can quote key material, so it is not attached.
    catch: () => new ServiceAccountKeyInvalid({ resourceName: name }),
  });

const getKey = (name: string) =>
  iam
    .getProjectsServiceAccountsKeys({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const ServiceAccountKeyProvider = () =>
  Provider.succeed(ServiceAccountKey, {
    stables: ["name", "serviceAccount", "privateKeyId", "privateKey"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (olds !== undefined && news.serviceAccount !== olds.serviceAccount) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    // A key carries no labels and its private half is only returned on
    // create, so only a key recorded in state can be read back.
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      return (yield* getKey(output.name)) === undefined ? undefined : output;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Observe: keep the key we made while it still exists.
      if (output !== undefined && (yield* getKey(output.name)) !== undefined) return output;

      // Ensure. A new account is eventually consistent: key creation can 404
      // for a few seconds after the account is created.
      const key = yield* iam
        .createProjectsServiceAccountsKeys({
          name: `projects/-/serviceAccounts/${news.serviceAccount}`,
          body: { privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE" },
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "NotFound",
            schedule: Schedule.exponential("500 millis"),
            times: 8,
          }),
        );
      const name = key.name ?? "";
      return {
        name,
        serviceAccount: news.serviceAccount,
        ...(yield* decodeKeyFile(name, key.privateKeyData ?? "")),
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteProjectsServiceAccountsKeys({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
