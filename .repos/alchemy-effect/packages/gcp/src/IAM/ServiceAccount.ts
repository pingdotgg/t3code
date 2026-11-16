import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { revokeHostIam, syncHostIam, type AppliedIamGrant, type GcpIamGrant } from "../Host.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { encodeOwnedDescription, hasOwnedDescription, parseOwnedDescription } from "./internal.ts";

const ACCOUNT_ID_MAX = 30;

export type ServiceAccountProps = {
  /** Project that owns the account. Defaults to the current GCP project. */
  project?: string;
  /**
   * Account id used as the email prefix: 6-30 lowercase letters, digits,
   * or hyphens. If omitted, a unique id is generated. Changing it
   * replaces the account.
   */
  accountId?: string;
  /** Human-readable display name (maximum 100 UTF-8 bytes). */
  displayName?: string;
  /**
   * Human-readable description. Service accounts have no labels, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from the `description` attribute. The marker and this text share the
   * API's 256-byte limit; overflow is truncated.
   */
  description?: string;
};

export type ServiceAccount = Resource<
  "GCP.IAM.ServiceAccount",
  ServiceAccountProps,
  {
    /** Full resource name `projects/{project}/serviceAccounts/{email}`. */
    name: string;
    /** Project that owns the account. */
    project: string;
    /** Account id (the email prefix). */
    accountId: string;
    /** Service-account email address. */
    email: string;
    /** Globally unique numeric id. */
    uniqueId: string | undefined;
    /** OAuth 2 client id. */
    oauth2ClientId: string | undefined;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Whether the account is disabled. */
    disabled: boolean | undefined;
    /** Roles granted through bindings, revoked once no binding asks for them. */
    iamGrants?: AppliedIamGrant[];
  },
  ServiceAccountBinding,
  Providers
>;

/** What a binding grants a {@link ServiceAccount}. */
export type ServiceAccountBinding = {
  /** Roles to grant the account, each on one resource (or the project). */
  iam?: GcpIamGrant[];
};

/**
 * A user-managed Google Cloud IAM service account.
 *
 * Grant it roles with `GCP.IAM.Member` (`kind: "project"` for project-wide
 * roles), and pass its `email` to resources that run as an identity, such
 * as GKE node pools or Compute instances.
 *
 * ### Creating a Service Account
 * **Example:** Service account with a generated id
 * ```typescript
 * const account = yield* GCP.IAM.ServiceAccount("Worker", {
 *   displayName: "Background worker",
 * });
 * ```
 *
 * **Example:** Service account with an explicit id
 * ```typescript
 * const account = yield* GCP.IAM.ServiceAccount("GkeNodes", {
 *   accountId: "prod-gke-nodes",
 *   displayName: "Production GKE nodes",
 * });
 * ```
 *
 * ### Granting Roles
 * **Example:** Let the account write logs in the project
 * ```typescript
 * const account = yield* GCP.IAM.ServiceAccount("Worker", {});
 * yield* GCP.IAM.Member("WorkerLogs", {
 *   kind: "project",
 *   name: account.project,
 *   role: "roles/logging.logWriter",
 *   member: Output.interpolate`serviceAccount:${account.email}`,
 * });
 * ```
 *
 * @resource
 * @category IAM
 */
export const ServiceAccount = Resource<ServiceAccount>("GCP.IAM.ServiceAccount");

export class ServiceAccountNotResolved extends Data.TaggedError(
  "GCP.IAM.ServiceAccountNotResolved",
)<{ resourceName: string }> {}

const accountIdFromEmail = (email: string) => email.split("@")[0] ?? email;
const emailOf = (project: string, accountId: string) =>
  `${accountId}@${project}.iam.gserviceaccount.com`;
const nameOf = (project: string, accountId: string) =>
  `projects/${project}/serviceAccounts/${emailOf(project, accountId)}`;

const toAttrs = (account: iam.ServiceAccount, project: string): ServiceAccount["Attributes"] => {
  const email = account.email ?? "";
  const accountId = accountIdFromEmail(email);
  return {
    name: account.name ?? nameOf(project, accountId),
    project: account.projectId ?? project,
    accountId,
    email,
    uniqueId: account.uniqueId,
    oauth2ClientId: account.oauth2ClientId,
    displayName: account.displayName,
    description: parseOwnedDescription(account.description).description,
    disabled: account.disabled,
  };
};

const getByName = (name: string) =>
  iam
    .getProjectsServiceAccounts({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const toAccountId = (id: string, explicit: string | undefined, existing: string | undefined) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      prefix: `alchemy-${id}-`,
      maxLength: ACCOUNT_ID_MAX,
      lowercase: true,
    });
  });

export const ServiceAccountProvider = () =>
  Provider.succeed(ServiceAccount, {
    stables: ["name", "project", "accountId", "email", "uniqueId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousProject = olds?.project ?? output?.project ?? env.project;
      const previousAccountId = olds?.accountId ?? output?.accountId;
      if (
        (news.project !== undefined && news.project !== previousProject) ||
        (news.accountId !== undefined && news.accountId !== previousAccountId)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const project = olds?.project ?? output?.project ?? env.project;
      const accountId = yield* toAccountId(id, olds?.accountId, output?.accountId);
      const existing = yield* getByName(output?.name ?? nameOf(project, accountId));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, project);
      const { labels } = parseOwnedDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* iam.listProjectsServiceAccounts
          .pages({
            name: `projects/${env.project}`,
            pageSize: 100,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.accounts ?? [])),
            Stream.filter((account) => hasOwnedDescription(account.description)),
            Stream.map((account) => toAttrs(account, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([] as ServiceAccount["Attributes"][])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const env = yield* GcpEnvironment.current;
      const project = news.project ?? output?.project ?? env.project;
      const accountId = yield* toAccountId(id, news.accountId, output?.accountId);
      const name = output?.name ?? nameOf(project, accountId);
      const internal = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnedDescription(internal, news.description);

      // Observe
      let current = yield* getByName(name);

      // Ensure — `Conflict` is a create race; adopt the winner.
      if (current === undefined) {
        current = yield* iam
          .createProjectsServiceAccounts({
            name: `projects/${project}`,
            body: {
              accountId,
              serviceAccount: {
                displayName: news.displayName,
                description: desiredDescription,
              },
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "ServiceAccountQuotaExceeded",
              times: 6,
              schedule: Schedule.exponential("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => getByName(name)),
          );
      }
      if (current === undefined) {
        return yield* new ServiceAccountNotResolved({ resourceName: name });
      }
      // A new account is eventually consistent: reads (and IAM bindings that
      // name it) fail with NotFound for a few seconds after create.
      current = yield* getByName(current.name ?? name).pipe(
        Effect.flatMap((account) =>
          account === undefined
            ? Effect.fail(new ServiceAccountNotResolved({ resourceName: name }))
            : Effect.succeed(account),
        ),
        Effect.retry({
          while: (error) => error._tag === "GCP.IAM.ServiceAccountNotResolved",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );

      // Sync display name and description against observed state.
      const updateMask = [
        (current.displayName ?? "") !== (news.displayName ?? "") ? "displayName" : undefined,
        (current.description ?? "") !== desiredDescription ? "description" : undefined,
      ].filter((field): field is string => field !== undefined);
      if (updateMask.length > 0) {
        const patched = yield* iam.patchProjectsServiceAccounts({
          name: current.name ?? name,
          body: {
            updateMask: updateMask.join(","),
            serviceAccount: {
              displayName: news.displayName ?? "",
              description: desiredDescription,
            },
          },
        });
        // The patch response only echoes the masked fields, and a re-read can
        // still return the previous values, so the patched fields win.
        current = {
          ...current,
          displayName: patched.displayName ?? news.displayName,
          description: patched.description ?? desiredDescription,
        };
      }

      // Sync the roles bindings grant the account. Roles it holds for other
      // reasons (e.g. a `GCP.IAM.Member`) are used but never revoked.
      const attrs = toAttrs(current, project);
      if (bindings.length === 0 && (output?.iamGrants ?? []).length === 0) return attrs;
      const { grants } = yield* syncHostIam({
        project: attrs.project,
        serviceAccount: attrs.email,
        managed: false,
        bindings,
        previous: output?.iamGrants,
      });
      return { ...attrs, iamGrants: grants };
    }),

    delete: Effect.fn(function* ({ output }) {
      // Revoke first, so no `deleted:serviceAccount:` members linger.
      yield* revokeHostIam({ serviceAccount: output.email, grants: output.iamGrants ?? [] });
      yield* iam
        .deleteProjectsServiceAccounts({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
