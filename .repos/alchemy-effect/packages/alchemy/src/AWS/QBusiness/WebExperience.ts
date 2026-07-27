import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export type WebExperienceStatus = qbusiness.WebExperienceStatus;

export interface WebExperienceProps {
  /**
   * The identifier of the Amazon Q Business application the web experience
   * fronts. Changing it replaces the web experience.
   */
  applicationId: string;
  /**
   * The title displayed in the web experience header.
   */
  title?: string;
  /**
   * The subtitle displayed under the title.
   */
  subtitle?: string;
  /**
   * A custom welcome message displayed when a conversation starts.
   */
  welcomeMessage?: string;
  /**
   * Whether sample chat prompts are shown to end users.
   */
  samplePromptsControlMode?: qbusiness.WebExperienceSamplePromptsControlMode;
  /**
   * Website domains allowed to embed the web experience.
   */
  origins?: string[];
  /**
   * ARN of the IAM role the web experience assumes to talk to the
   * application on behalf of end users.
   */
  roleArn?: string;
  /**
   * External identity-provider settings (SAML or OIDC) for the web
   * experience.
   */
  identityProviderConfiguration?: qbusiness.IdentityProviderConfiguration;
  /**
   * Which browser extensions (Chrome, Firefox) may connect to the web
   * experience.
   */
  browserExtensionConfiguration?: qbusiness.BrowserExtensionConfiguration;
  /**
   * Custom logo/font/CSS customization for the web experience.
   */
  customizationConfiguration?: qbusiness.CustomizationConfiguration;
  /**
   * Tags to associate with the web experience.
   */
  tags?: Record<string, string>;
}

export interface WebExperience extends Resource<
  "AWS.QBusiness.WebExperience",
  WebExperienceProps,
  {
    /**
     * Service-assigned unique identifier of the web experience (unique
     * within its application).
     */
    webExperienceId: string;
    /**
     * The identifier of the application the web experience belongs to.
     */
    applicationId: string;
    /**
     * ARN of the web experience.
     */
    webExperienceArn: string;
    /**
     * The AWS-hosted URL end users open to chat with the application.
     */
    defaultEndpoint: string | undefined;
    /**
     * Current lifecycle status of the web experience.
     */
    status: WebExperienceStatus | undefined;
    /**
     * Current tags reported for the web experience.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Q Business web experience — the hosted chat UI end users open
 * to converse with an application.
 *
 * @resource
 * @section Creating Web Experiences
 * @example Basic Web Experience
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const web = yield* AWS.QBusiness.WebExperience("Chat", {
 *   applicationId: app.applicationId,
 *   title: "Company Assistant",
 *   welcomeMessage: "Ask me anything about our docs.",
 * });
 * ```
 *
 * @example Embeddable Web Experience
 * ```typescript
 * const web = yield* AWS.QBusiness.WebExperience("Chat", {
 *   applicationId: app.applicationId,
 *   origins: ["https://intranet.example.com"],
 *   samplePromptsControlMode: "ENABLED",
 * });
 * ```
 */
export const WebExperience = Resource<WebExperience>(
  "AWS.QBusiness.WebExperience",
);

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

interface WebExperienceState {
  attrs: WebExperience["Attributes"];
  described: qbusiness.GetWebExperienceResponse;
}

const readWebExperienceById = Effect.fn(function* (
  applicationId: string,
  webExperienceId: string,
) {
  const described = yield* qbusiness
    .getWebExperience({ applicationId, webExperienceId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described || described.status === "DELETING") return undefined;
  const arn = described.webExperienceArn;
  if (arn === undefined) return undefined;
  const state: WebExperienceState = {
    described,
    attrs: {
      webExperienceId: described.webExperienceId ?? webExperienceId,
      applicationId: described.applicationId ?? applicationId,
      webExperienceArn: arn,
      defaultEndpoint: described.defaultEndpoint,
      status: described.status,
      tags: yield* fetchTags(arn),
    },
  };
  return state;
});

/**
 * A web experience still transitioning toward a settled status — retried by
 * {@link waitForWebExperienceSettled}'s bounded schedule.
 */
class WebExperienceNotReady extends Data.TaggedError("WebExperienceNotReady")<{
  readonly webExperienceId: string;
  readonly status: string | undefined;
}> {}

/**
 * A web experience whose asynchronous provisioning converged to the
 * terminal `FAILED` status.
 */
export class WebExperienceProvisioningFailed extends Data.TaggedError(
  "WebExperienceProvisioningFailed",
)<{
  readonly webExperienceId: string;
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
    while: (e) => e._tag === "WebExperienceNotReady",
    // Web experience provisioning is fast; poll every 5s up to ~5 min.
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(60)]),
  });

// A web experience without identity-provider auth settles in
// PENDING_AUTH_CONFIG rather than ACTIVE — both are converged states.
const waitForWebExperienceSettled = (
  applicationId: string,
  webExperienceId: string,
  target: "SETTLED" | "DELETED",
) =>
  retryWhileNotReady(
    Effect.gen(function* () {
      const described = yield* qbusiness
        .getWebExperience({ applicationId, webExperienceId })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (target === "DELETED") {
        if (described === undefined) return;
        return yield* Effect.fail(
          new WebExperienceNotReady({
            webExperienceId,
            status: described.status,
          }),
        );
      }
      if (
        described?.status === "ACTIVE" ||
        described?.status === "PENDING_AUTH_CONFIG"
      ) {
        return;
      }
      if (described?.status === "FAILED") {
        return yield* Effect.fail(
          new WebExperienceProvisioningFailed({
            webExperienceId,
            message: described.error?.errorMessage,
          }),
        );
      }
      return yield* Effect.fail(
        new WebExperienceNotReady({
          webExperienceId,
          status: described?.status,
        }),
      );
    }),
  );

export const WebExperienceProvider = () =>
  Provider.effect(
    WebExperience,
    Effect.gen(function* () {
      return {
        stables: ["webExperienceId", "applicationId", "webExperienceArn"],
        // Keyed by a parent application; cannot be enumerated account-wide
        // without iterating every application — treated as a sub-resource per
        // the factory list() convention.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const applicationId = output?.applicationId ?? olds?.applicationId;
          // Web experience summaries carry no display name, so there is no
          // name-based fallback — without a cached id the resource is
          // treated as missing.
          if (
            applicationId === undefined ||
            output?.webExperienceId === undefined
          ) {
            return undefined;
          }
          const state = yield* readWebExperienceById(
            applicationId,
            output.webExperienceId,
          );
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The parent application is fixed at creation.
          if (olds.applicationId !== news.applicationId) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("QBusiness WebExperience requires props"),
            );
          }
          const applicationId = news.applicationId;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — the cached id is the only handle (summaries carry no
          // display name to search by).
          let state = output?.webExperienceId
            ? yield* readWebExperienceById(
                applicationId,
                output.webExperienceId,
              )
            : undefined;

          // Ensure — create if missing, then wait for a settled status.
          if (state === undefined) {
            const created = yield* qbusiness.createWebExperience({
              applicationId,
              title: news.title,
              subtitle: news.subtitle,
              welcomeMessage: news.welcomeMessage,
              samplePromptsControlMode: news.samplePromptsControlMode,
              origins: news.origins,
              roleArn: news.roleArn,
              identityProviderConfiguration: news.identityProviderConfiguration,
              browserExtensionConfiguration: news.browserExtensionConfiguration,
              customizationConfiguration: news.customizationConfiguration,
              tags: Object.entries(desiredTags).map(([key, value]) => ({
                key,
                value,
              })),
            });
            if (!created.webExperienceId) {
              return yield* Effect.fail(
                new Error(
                  `CreateWebExperience for '${id}' returned no webExperienceId`,
                ),
              );
            }
            yield* session.note(
              `Creating web experience (${created.webExperienceId})...`,
            );
            yield* waitForWebExperienceSettled(
              applicationId,
              created.webExperienceId,
              "SETTLED",
            );
            state = yield* readWebExperienceById(
              applicationId,
              created.webExperienceId,
            );
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created web experience for '${id}'`),
              );
            }
          }

          // Sync mutable settings via UpdateWebExperience — only when
          // drifted.
          const described = state.described;
          const needsUpdate =
            (news.title ?? "") !== (described.title ?? "") ||
            (news.subtitle ?? "") !== (described.subtitle ?? "") ||
            (news.welcomeMessage ?? "") !== (described.welcomeMessage ?? "") ||
            (news.samplePromptsControlMode !== undefined &&
              news.samplePromptsControlMode !==
                described.samplePromptsControlMode) ||
            (news.roleArn !== undefined &&
              news.roleArn !== described.roleArn) ||
            JSON.stringify(news.origins ?? []) !==
              JSON.stringify(described.origins ?? []) ||
            news.identityProviderConfiguration !== undefined ||
            news.browserExtensionConfiguration !== undefined ||
            news.customizationConfiguration !== undefined;
          if (needsUpdate) {
            yield* qbusiness.updateWebExperience({
              applicationId,
              webExperienceId: state.attrs.webExperienceId,
              title: news.title,
              subtitle: news.subtitle,
              welcomeMessage: news.welcomeMessage,
              samplePromptsControlMode: news.samplePromptsControlMode,
              origins: news.origins,
              roleArn: news.roleArn,
              identityProviderConfiguration: news.identityProviderConfiguration,
              browserExtensionConfiguration: news.browserExtensionConfiguration,
              customizationConfiguration: news.customizationConfiguration,
            });
            yield* waitForWebExperienceSettled(
              applicationId,
              state.attrs.webExperienceId,
              "SETTLED",
            );
            yield* session.note(`Updated web experience ${id}`);
          }

          // Sync tags — diff against observed cloud tags.
          const { removed, upsert } = diffTags(state.attrs.tags, desiredTags);
          if (removed.length > 0) {
            yield* qbusiness.untagResource({
              resourceARN: state.attrs.webExperienceArn,
              tagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* qbusiness.tagResource({
              resourceARN: state.attrs.webExperienceArn,
              tags: upsert.map(({ Key, Value }) => ({
                key: Key,
                value: Value,
              })),
            });
          }

          yield* session.note(state.attrs.webExperienceArn);

          const final = yield* readWebExperienceById(
            applicationId,
            state.attrs.webExperienceId,
          );
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled web experience for '${id}'`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* qbusiness
            .deleteWebExperience({
              applicationId: output.applicationId,
              webExperienceId: output.webExperienceId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          yield* waitForWebExperienceSettled(
            output.applicationId,
            output.webExperienceId,
            "DELETED",
          );
        }),
      };
    }),
  );
