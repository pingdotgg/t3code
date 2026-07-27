import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export type ApplicationStatus = qbusiness.ApplicationStatus;
export type IdentityType = qbusiness.IdentityType;

/**
 * Encryption-at-rest configuration for an Amazon Q Business application.
 */
export interface ApplicationEncryptionConfiguration {
  /**
   * The identifier of the customer-managed KMS key. Amazon Q Business does
   * not support asymmetric keys.
   */
  kmsKeyId?: string;
}

export interface ApplicationProps {
  /**
   * Display name of the application.
   * @default ${app}-${stage}-${id}
   */
  displayName?: string;
  /**
   * The authentication type the application connects users with.
   * `AWS_IAM_IDC` (IAM Identity Center) is the default and requires
   * `identityCenterInstanceArn`. Changing it replaces the application.
   * @default "AWS_IAM_IDC"
   */
  identityType?: IdentityType;
  /**
   * ARN of the IAM Identity Center instance the application connects to.
   * Required when `identityType` is `AWS_IAM_IDC` (the default).
   */
  identityCenterInstanceArn?: string;
  /**
   * ARN of an IAM identity provider (SAML/OIDC) when `identityType` is
   * `AWS_IAM_IDP_SAML` or `AWS_IAM_IDP_OIDC`. Changing it replaces the
   * application.
   */
  iamIdentityProviderArn?: string;
  /**
   * OIDC client IDs when `identityType` is `AWS_IAM_IDP_OIDC`. Changing
   * them replaces the application.
   */
  clientIdsForOIDC?: string[];
  /**
   * ARN of the IAM role Amazon Q Business assumes to publish CloudWatch
   * logs and metrics.
   */
  roleArn?: string;
  /**
   * A description of the application.
   */
  description?: string;
  /**
   * Encryption-at-rest configuration. Changing it replaces the application.
   */
  encryptionConfiguration?: ApplicationEncryptionConfiguration;
  /**
   * Whether end users can upload files directly into chat conversations.
   */
  attachmentsConfiguration?: qbusiness.AttachmentsConfiguration;
  /**
   * Whether end users can create and use Amazon Q Apps.
   */
  qAppsConfiguration?: qbusiness.QAppsConfiguration;
  /**
   * Whether Amazon Q Business personalizes chat responses using details
   * from the user's IAM Identity Center profile.
   */
  personalizationConfiguration?: qbusiness.PersonalizationConfiguration;
  /**
   * Automatic-subscription settings for users of the application.
   */
  autoSubscriptionConfiguration?: qbusiness.AutoSubscriptionConfiguration;
  /**
   * Amazon QuickSight identity configuration, when `identityType` is
   * `AWS_QUICKSIGHT_IDP`. Changing it replaces the application.
   */
  quickSightConfiguration?: qbusiness.QuickSightConfiguration;
  /**
   * Tags to associate with the application.
   */
  tags?: Record<string, string>;
}

export interface Application extends Resource<
  "AWS.QBusiness.Application",
  ApplicationProps,
  {
    /**
     * Service-assigned unique identifier of the application.
     */
    applicationId: string;
    /**
     * ARN of the application.
     */
    applicationArn: string;
    /**
     * The application's display name.
     */
    displayName: string;
    /**
     * Current lifecycle status of the application.
     */
    status: ApplicationStatus | undefined;
    /**
     * The authentication type the application was created with.
     */
    identityType: IdentityType | undefined;
    /**
     * ARN of the IAM Identity Center application created for this Amazon Q
     * Business application (when `identityType` is `AWS_IAM_IDC`).
     */
    identityCenterApplicationArn: string | undefined;
    /**
     * ARN of the IAM role used for CloudWatch logs/metrics.
     */
    roleArn: string | undefined;
    /**
     * Current tags reported for the application.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Q Business application — the top-level container that indices,
 * retrievers, data sources, and web experiences attach to.
 *
 * :::caution
 * Creating an application with the default `AWS_IAM_IDC` identity type
 * requires an IAM Identity Center instance in the account (pass its ARN as
 * `identityCenterInstanceArn`).
 * :::
 * @resource
 * @section Creating Applications
 * @example Identity Center Application
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const app = yield* AWS.QBusiness.Application("Assistant", {
 *   identityCenterInstanceArn: "arn:aws:sso:::instance/ssoins-1234567890abcdef",
 *   description: "Company knowledge assistant",
 * });
 * ```
 *
 * @example Anonymous Application
 * ```typescript
 * const app = yield* AWS.QBusiness.Application("PublicAssistant", {
 *   identityType: "ANONYMOUS",
 * });
 * ```
 */
export const Application = Resource<Application>("AWS.QBusiness.Application");

const createDisplayName = (
  id: string,
  props: { displayName?: string | undefined },
) =>
  props.displayName
    ? Effect.succeed(props.displayName)
    : createPhysicalName({ id, maxLength: 100 });

const fetchTags = Effect.fn(function* (arn: string) {
  const response = yield* qbusiness
    .listTagsForResource({ resourceARN: arn })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  return Object.fromEntries(
    (response?.tags ?? []).map((tag) => [tag.key, tag.value]),
  );
});

interface ApplicationState {
  attrs: Application["Attributes"];
  described: qbusiness.GetApplicationResponse;
}

const readApplicationById = Effect.fn(function* (applicationId: string) {
  const described = yield* qbusiness
    .getApplication({ applicationId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described || described.status === "DELETING") return undefined;
  const arn = described.applicationArn;
  if (arn === undefined) return undefined;
  const state: ApplicationState = {
    described,
    attrs: {
      applicationId: described.applicationId ?? applicationId,
      applicationArn: arn,
      displayName: described.displayName ?? "",
      status: described.status,
      identityType: described.identityType,
      identityCenterApplicationArn: described.identityCenterApplicationArn,
      roleArn: described.roleArn,
      tags: yield* fetchTags(arn),
    },
  };
  return state;
});

const findApplicationByName = Effect.fn(function* (displayName: string) {
  const summaries = yield* qbusiness.listApplications.pages({}).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) => page.applications ?? []),
    ),
  );
  const match = summaries.find(
    (summary) =>
      summary.displayName === displayName && summary.status !== "DELETING",
  );
  if (!match?.applicationId) return undefined;
  return yield* readApplicationById(match.applicationId);
});

/**
 * An application still transitioning toward the awaited status — retried by
 * {@link waitForApplicationStatus}'s bounded schedule.
 */
class ApplicationNotReady extends Data.TaggedError("ApplicationNotReady")<{
  readonly applicationId: string;
  readonly status: string | undefined;
}> {}

/**
 * An application whose asynchronous provisioning converged to the terminal
 * `FAILED` status.
 */
export class ApplicationProvisioningFailed extends Data.TaggedError(
  "ApplicationProvisioningFailed",
)<{
  readonly applicationId: string;
  readonly message: string | undefined;
}> {}

// Explicitly-typed retry wrapper — an inline `Effect.retry` in provider
// lifecycle code leaks `Retry.Return`'s conditional type into declaration
// emit and widens the provider layer to `unknown` for every consumer of
// `AWS.providers()`.
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ApplicationNotReady",
    // Application provisioning normally completes within a couple minutes;
    // poll every 5s up to ~10 min.
    schedule: Schedule.max([
      Schedule.spaced("5 seconds"),
      Schedule.recurs(120),
    ]),
  });

// Deleting an application while dependent resources are still tearing down
// surfaces as ConflictException. Bounded retry through the window.
const retryThroughConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([
      Schedule.spaced("10 seconds"),
      Schedule.recurs(10),
    ]),
  });

const waitForApplicationStatus = (
  applicationId: string,
  target: "ACTIVE" | "DELETED",
) =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* qbusiness
        .getApplication({ applicationId })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (target === "DELETED") {
        if (described === undefined) return;
        return yield* Effect.fail(
          new ApplicationNotReady({ applicationId, status: described.status }),
        );
      }
      if (described?.status === "ACTIVE") return;
      if (described?.status === "FAILED") {
        return yield* Effect.fail(
          new ApplicationProvisioningFailed({
            applicationId,
            message: described.error?.errorMessage,
          }),
        );
      }
      return yield* Effect.fail(
        new ApplicationNotReady({ applicationId, status: described?.status }),
      );
    }),
  );

export const ApplicationProvider = () =>
  Provider.effect(
    Application,
    Effect.gen(function* () {
      return {
        stables: ["applicationId", "applicationArn"],
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* qbusiness.listApplications.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.applications ?? []),
              ),
            );
            const hydrated = yield* Effect.forEach(
              summaries.flatMap((s) =>
                s.applicationId ? [s.applicationId] : [],
              ),
              (applicationId) => readApplicationById(applicationId),
              { concurrency: 5 },
            );
            return hydrated.flatMap((state) =>
              state === undefined ? [] : [state.attrs],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const state = output?.applicationId
            ? yield* readApplicationById(output.applicationId)
            : yield* findApplicationByName(
                yield* createDisplayName(id, olds ?? {}),
              );
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // Identity wiring and encryption-at-rest are fixed at creation.
          if (
            (olds.identityType ?? "AWS_IAM_IDC") !==
              (news.identityType ?? "AWS_IAM_IDC") ||
            olds.iamIdentityProviderArn !== news.iamIdentityProviderArn ||
            olds.encryptionConfiguration?.kmsKeyId !==
              news.encryptionConfiguration?.kmsKeyId ||
            olds.quickSightConfiguration?.clientNamespace !==
              news.quickSightConfiguration?.clientNamespace ||
            JSON.stringify(olds.clientIdsForOIDC ?? []) !==
              JSON.stringify(news.clientIdsForOIDC ?? [])
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("QBusiness Application requires props"),
            );
          }
          const displayName = yield* createDisplayName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the cached id; fall back to a name lookup so a
          // create whose state failed to persist is adopted, not duplicated.
          let state = output?.applicationId
            ? yield* readApplicationById(output.applicationId)
            : yield* findApplicationByName(displayName);

          // Ensure — create if missing, then wait for ACTIVE.
          if (state === undefined) {
            const created = yield* qbusiness.createApplication({
              displayName,
              identityType: news.identityType,
              identityCenterInstanceArn: news.identityCenterInstanceArn,
              iamIdentityProviderArn: news.iamIdentityProviderArn,
              clientIdsForOIDC: news.clientIdsForOIDC,
              roleArn: news.roleArn,
              description: news.description,
              encryptionConfiguration: news.encryptionConfiguration,
              attachmentsConfiguration: news.attachmentsConfiguration,
              qAppsConfiguration: news.qAppsConfiguration,
              personalizationConfiguration: news.personalizationConfiguration,
              quickSightConfiguration: news.quickSightConfiguration,
              tags: Object.entries(desiredTags).map(([key, value]) => ({
                key,
                value,
              })),
            });
            if (!created.applicationId) {
              return yield* Effect.fail(
                new Error(
                  `CreateApplication for '${displayName}' returned no applicationId`,
                ),
              );
            }
            yield* session.note(
              `Creating application ${displayName} (${created.applicationId})...`,
            );
            yield* waitForApplicationStatus(created.applicationId, "ACTIVE");
            state = yield* readApplicationById(created.applicationId);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created application ${displayName}`),
              );
            }
          }

          // Sync mutable settings via UpdateApplication — only when drifted.
          const described = state.described;
          const needsUpdate =
            displayName !== described.displayName ||
            (news.description ?? "") !== (described.description ?? "") ||
            (news.roleArn !== undefined &&
              news.roleArn !== described.roleArn) ||
            (news.attachmentsConfiguration !== undefined &&
              news.attachmentsConfiguration.attachmentsControlMode !==
                described.attachmentsConfiguration?.attachmentsControlMode) ||
            (news.qAppsConfiguration !== undefined &&
              news.qAppsConfiguration.qAppsControlMode !==
                described.qAppsConfiguration?.qAppsControlMode) ||
            (news.personalizationConfiguration !== undefined &&
              news.personalizationConfiguration.personalizationControlMode !==
                described.personalizationConfiguration
                  ?.personalizationControlMode) ||
            (news.autoSubscriptionConfiguration !== undefined &&
              (news.autoSubscriptionConfiguration.autoSubscribe !==
                described.autoSubscriptionConfiguration?.autoSubscribe ||
                news.autoSubscriptionConfiguration.defaultSubscriptionType !==
                  described.autoSubscriptionConfiguration
                    ?.defaultSubscriptionType));
          if (needsUpdate) {
            yield* qbusiness.updateApplication({
              applicationId: state.attrs.applicationId,
              displayName,
              description: news.description,
              roleArn: news.roleArn,
              identityCenterInstanceArn: news.identityCenterInstanceArn,
              attachmentsConfiguration: news.attachmentsConfiguration,
              qAppsConfiguration: news.qAppsConfiguration,
              personalizationConfiguration: news.personalizationConfiguration,
              autoSubscriptionConfiguration: news.autoSubscriptionConfiguration,
            });
            yield* waitForApplicationStatus(
              state.attrs.applicationId,
              "ACTIVE",
            );
            yield* session.note(`Updated application ${displayName}`);
          }

          // Sync tags — diff against observed cloud tags.
          const { removed, upsert } = diffTags(state.attrs.tags, desiredTags);
          if (removed.length > 0) {
            yield* qbusiness.untagResource({
              resourceARN: state.attrs.applicationArn,
              tagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* qbusiness.tagResource({
              resourceARN: state.attrs.applicationArn,
              tags: upsert.map(({ Key, Value }) => ({
                key: Key,
                value: Value,
              })),
            });
          }

          yield* session.note(state.attrs.applicationArn);

          const final = yield* readApplicationById(state.attrs.applicationId);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled application ${displayName}`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryThroughConflict(
            qbusiness
              .deleteApplication({ applicationId: output.applicationId })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
          yield* waitForApplicationStatus(output.applicationId, "DELETED");
        }),
      };
    }),
  );
