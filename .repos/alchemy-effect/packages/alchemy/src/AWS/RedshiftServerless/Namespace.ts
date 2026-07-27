import * as redshiftserverless from "@distilled.cloud/aws/redshift-serverless";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readTags, syncTags, toWireTags } from "./internal.ts";

export interface NamespaceProps {
  /**
   * Name of the namespace. Must be 3-64 characters, lowercase letters,
   * numbers, and hyphens. If omitted, a deterministic physical name is
   * generated. Changing the name replaces the namespace.
   */
  namespaceName?: string;
  /**
   * Name of the first database created in the namespace. Changing the
   * database name replaces the namespace.
   * @default "dev"
   */
  dbName?: string;
  /**
   * Administrator username for the namespace's initial database. Provide it
   * together with `adminUserPassword`, or set `manageAdminPassword` to have
   * Redshift store a generated password in Secrets Manager.
   */
  adminUsername?: string;
  /**
   * Administrator password. Ignored when `manageAdminPassword` is true.
   */
  adminUserPassword?: Redacted.Redacted<string>;
  /**
   * Let Redshift generate and manage the admin password in Secrets Manager.
   * The secret ARN is returned as `adminPasswordSecretArn`.
   * @default false
   */
  manageAdminPassword?: boolean;
  /**
   * Customer-managed KMS key ID used to encrypt the Secrets Manager secret
   * that holds the managed admin password.
   */
  adminPasswordSecretKmsKeyId?: string;
  /**
   * Customer-managed KMS key ID used to encrypt the namespace's data.
   * Changing the key replaces the namespace.
   * @default AWS-owned key
   */
  kmsKeyId?: string;
  /**
   * ARN of the IAM role set as the namespace's default role. Must also be a
   * member of `iamRoles`.
   */
  defaultIamRoleArn?: string;
  /**
   * ARNs of IAM roles associated with the namespace (used by COPY/UNLOAD and
   * other role-based features).
   */
  iamRoles?: string[];
  /**
   * Log types exported to CloudWatch Logs: `userlog`, `connectionlog`,
   * and/or `useractivitylog`.
   */
  logExports?: ("userlog" | "connectionlog" | "useractivitylog")[];
  /**
   * User-defined tags for the namespace.
   */
  tags?: Record<string, string>;
}

export interface Namespace extends Resource<
  "AWS.RedshiftServerless.Namespace",
  NamespaceProps,
  {
    /**
     * Name of the namespace.
     */
    namespaceName: string;
    /**
     * ARN of the namespace.
     */
    namespaceArn: string;
    /**
     * Unique ID of the namespace.
     */
    namespaceId: string;
    /**
     * Name of the first database created in the namespace.
     */
    dbName: string | undefined;
    /**
     * ARN of the Secrets Manager secret holding the admin password when
     * `manageAdminPassword` is enabled.
     */
    adminPasswordSecretArn: string | undefined;
    /**
     * Current namespace status (e.g. `"AVAILABLE"`).
     */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Redshift Serverless namespace — the storage-and-database half of
 * a serverless data warehouse.
 *
 * A namespace holds databases, schemas, tables, admin credentials, and IAM
 * roles. Compute is provided separately by a {@link Workgroup} that points at
 * the namespace. Creating a namespace is quick (~1 minute); the provider
 * waits (bounded) for it to become `AVAILABLE`.
 *
 * @resource
 * @section Creating a Namespace
 * @example Inline Admin Credentials
 * ```typescript
 * const namespace = yield* RedshiftServerless.Namespace("Analytics", {
 *   dbName: "analytics",
 *   adminUsername: "admin",
 *   adminUserPassword: Redacted.make("SuperSecret123!"),
 * });
 * ```
 *
 * @example Secrets-Manager-Managed Admin Password
 * ```typescript
 * const namespace = yield* RedshiftServerless.Namespace("Analytics", {
 *   dbName: "analytics",
 *   adminUsername: "admin",
 *   manageAdminPassword: true,
 * });
 * // namespace.adminPasswordSecretArn -> the generated secret's ARN
 * ```
 *
 * @section IAM Roles and Encryption
 * @example Default Role and Customer KMS Key
 * ```typescript
 * const namespace = yield* RedshiftServerless.Namespace("Analytics", {
 *   dbName: "analytics",
 *   defaultIamRoleArn: role.roleArn,
 *   iamRoles: [role.roleArn],
 *   kmsKeyId: key.keyId,
 *   logExports: ["userlog", "connectionlog"],
 * });
 * ```
 */
export const Namespace = Resource<Namespace>(
  "AWS.RedshiftServerless.Namespace",
);

class NamespaceNotSettled extends Data.TaggedError("NamespaceNotSettled")<{
  readonly namespaceName: string;
  readonly status: string;
}> {}

const statusIs = (status: string | undefined, expected: string): boolean =>
  status?.toUpperCase() === expected;

const sameStringSet = (a: string[], b: string[]): boolean => {
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
};

export const NamespaceProvider = () =>
  Provider.effect(
    Namespace,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<NamespaceProps>) =>
        props.namespaceName
          ? Effect.succeed(props.namespaceName)
          : createPhysicalName({ id, maxLength: 64 });

      const readNamespace = Effect.fn(function* (name: string) {
        const response = yield* redshiftserverless
          .getNamespace({ namespaceName: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.namespace;
      });

      // Namespace create/update converge through a MODIFYING status. It
      // typically settles within a minute; budget ~3 min (36 * 5s).
      const waitForAvailable = Effect.fn(function* (name: string) {
        return yield* readNamespace(name).pipe(
          Effect.flatMap((ns) =>
            ns !== undefined && !statusIs(ns.status, "AVAILABLE")
              ? Effect.fail(
                  new NamespaceNotSettled({
                    namespaceName: name,
                    status: ns.status ?? "UNKNOWN",
                  }),
                )
              : Effect.succeed(ns),
          ),
          Effect.retry({
            while: (e) => e instanceof NamespaceNotSettled,
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(36),
            ]),
          }),
        );
      });

      const waitUntilGone = Effect.fn(function* (name: string) {
        yield* readNamespace(name).pipe(
          Effect.flatMap((ns) =>
            ns === undefined
              ? Effect.void
              : Effect.fail(
                  new NamespaceNotSettled({
                    namespaceName: name,
                    status: ns.status ?? "DELETING",
                  }),
                ),
          ),
          Effect.retry({
            while: (e) => e instanceof NamespaceNotSettled,
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(60),
            ]),
          }),
        );
      });

      const toAttrs = (ns: redshiftserverless.Namespace) => ({
        namespaceName: ns.namespaceName!,
        namespaceArn: ns.namespaceArn!,
        namespaceId: ns.namespaceId!,
        dbName: ns.dbName,
        adminPasswordSecretArn: ns.adminPasswordSecretArn,
        status: ns.status ?? "UNKNOWN",
      });

      return {
        stables: ["namespaceName", "namespaceArn", "namespaceId"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // dbName and the KMS key are create-only.
          if ((news?.dbName ?? undefined) !== (olds?.dbName ?? undefined)) {
            return { action: "replace" } as const;
          }
          if ((news?.kmsKeyId ?? undefined) !== (olds?.kmsKeyId ?? undefined)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.namespaceName ?? (yield* toName(id, olds ?? {}));
          const ns = yield* readNamespace(name);
          if (ns === undefined) return undefined;
          const attrs = toAttrs(ns);
          const tags = yield* readTags(attrs.namespaceArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.namespaceName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readNamespace(name);

          // 2. Ensure — create if missing; tolerate a concurrent create.
          if (observed === undefined) {
            const created = yield* redshiftserverless
              .createNamespace({
                namespaceName: name,
                dbName: news.dbName,
                adminUsername: news.adminUsername,
                // Redshift generates the password when it manages it; passing
                // one alongside manageAdminPassword is rejected.
                adminUserPassword: news.manageAdminPassword
                  ? undefined
                  : news.adminUserPassword,
                manageAdminPassword: news.manageAdminPassword,
                adminPasswordSecretKmsKeyId: news.adminPasswordSecretKmsKeyId,
                kmsKeyId: news.kmsKeyId,
                defaultIamRoleArn: news.defaultIamRoleArn,
                iamRoles: news.iamRoles,
                logExports: news.logExports,
                tags: toWireTags(desiredTags),
              })
              .pipe(
                Effect.map((r) => r.namespace),
                Effect.catchTag("ConflictException", () =>
                  redshiftserverless
                    .getNamespace({ namespaceName: name })
                    .pipe(Effect.map((r) => r.namespace)),
                ),
              );
            observed = created;
          }

          const settled = yield* waitForAvailable(name);
          if (settled !== undefined) observed = settled;
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(
                `Redshift namespace '${name}' disappeared while reconciling`,
              ),
            );
          }

          // 3. Sync — apply mutable aspects the user specified when they drift
          // from OBSERVED state.
          const update: Omit<
            redshiftserverless.UpdateNamespaceRequest,
            "namespaceName"
          > = {};
          if (
            news.defaultIamRoleArn !== undefined &&
            observed.defaultIamRoleArn !== news.defaultIamRoleArn
          ) {
            update.defaultIamRoleArn = news.defaultIamRoleArn;
          }
          if (
            news.iamRoles !== undefined &&
            !sameStringSet(observed.iamRoles ?? [], news.iamRoles)
          ) {
            update.iamRoles = news.iamRoles;
          }
          if (
            news.logExports !== undefined &&
            !sameStringSet(observed.logExports ?? [], news.logExports)
          ) {
            update.logExports = news.logExports;
          }
          if (Object.keys(update).length > 0) {
            yield* redshiftserverless.updateNamespace({
              namespaceName: name,
              ...update,
            });
            const updated = yield* waitForAvailable(name);
            if (updated !== undefined) observed = updated;
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncTags(observed.namespaceArn!, desiredTags);

          // 4. Return fresh attributes.
          yield* session.note(name);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* redshiftserverless
            .deleteNamespace({ namespaceName: output.namespaceName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              // A workgroup may still be detaching — retry briefly.
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(24),
                ]),
              }),
              Effect.catchTag("ConflictException", () => Effect.void),
            );
          yield* waitUntilGone(output.namespaceName);
        }),

        list: () =>
          redshiftserverless.listNamespaces.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.namespaces ?? [])
                .flatMap((ns) =>
                  ns.namespaceName !== undefined &&
                  ns.namespaceArn !== undefined &&
                  ns.namespaceId !== undefined
                    ? [
                        {
                          namespaceName: ns.namespaceName,
                          namespaceArn: ns.namespaceArn,
                          namespaceId: ns.namespaceId,
                          dbName: ns.dbName,
                          adminPasswordSecretArn: ns.adminPasswordSecretArn,
                          status: ns.status ?? "UNKNOWN",
                        },
                      ]
                    : [],
                ),
            ),
          ),
      };
    }),
  );
