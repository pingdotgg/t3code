import * as ces from "@distilled.cloud/gcp/ces_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  expandApp,
  forEachApp,
  hasOwnershipMarker,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

const DEFAULT_CONTENT_FILTER: ces.GuardrailContentFilter = {
  matchType: "SIMPLE_STRING_MATCH",
  bannedContents: ["alchemy-ban"],
};

export type AppsGuardrailProps = {
  /**
   * Parent CES app. Full name
   * `projects/{project}/locations/{location}/apps/{app}` or the app id
   * (combined with `location`). Immutable — changing it replaces the
   * guardrail.
   */
  app: string;
  /**
   * Region used when `app` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Guardrail id. If omitted, a unique name is generated. Immutable —
   * changing it replaces the guardrail.
   */
  guardrailId?: string;
  /**
   * Human-readable name. Required by the API; Alchemy falls back to the
   * generated guardrail id.
   */
  displayName?: string;
  /**
   * Human-readable description. Guardrails have no labels field, so
   * Alchemy stamps ownership into this field.
   */
  description?: string;
  /**
   * Whether the guardrail is enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Phrase / regexp content filter. Defaults to a simple-string match
   * on `alchemy-ban` when no other check is set.
   */
  contentFilter?: ces.GuardrailContentFilter;
  /**
   * LLM policy check.
   */
  llmPolicy?: ces.GuardrailLlmPolicy;
  /**
   * Prompt-security check.
   */
  llmPromptSecurity?: ces.GuardrailLlmPromptSecurity;
  /**
   * Model safety overrides.
   */
  modelSafety?: ces.GuardrailModelSafety;
  /**
   * Code-callback check.
   */
  codeCallback?: ces.GuardrailCodeCallback;
  /**
   * Action taken when the guardrail triggers.
   */
  action?: ces.TriggerAction;
};

export type AppsGuardrail = Resource<
  "GCP.CES.AppsGuardrail",
  AppsGuardrailProps,
  {
    /** Full resource name `.../apps/{app}/guardrails/{guardrail}`. */
    name: string;
    /** Guardrail id (last path segment). */
    guardrailId: string;
    /** Parent app resource name. */
    app: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether the guardrail is enabled. */
    enabled: boolean;
    /** Content filter. */
    contentFilter: ces.GuardrailContentFilter | undefined;
    /** LLM policy. */
    llmPolicy: ces.GuardrailLlmPolicy | undefined;
    /** Prompt-security check. */
    llmPromptSecurity: ces.GuardrailLlmPromptSecurity | undefined;
    /** Model safety overrides. */
    modelSafety: ces.GuardrailModelSafety | undefined;
    /** Code-callback check. */
    codeCallback: ces.GuardrailCodeCallback | undefined;
    /** Trigger action. */
    action: ces.TriggerAction | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-assigned etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Customer Engagement Suite guardrail — content filter, LLM policy,
 * model safety, or callback checks attached to an app or agent.
 *
 * Guardrails have no labels field — Alchemy stamps ownership into
 * `description` so `list` / nuke can find them. Parent app, location,
 * and guardrail id are immutable.
 *
 * ### Creating a Guardrail
 * **Example:** Banned-phrase filter
 * ```typescript
 * const guardrail = yield* GCP.CES.AppsGuardrail("Safety", {
 *   app: app.name,
 *   displayName: "safety",
 *   contentFilter: {
 *     matchType: "SIMPLE_STRING_MATCH",
 *     bannedContents: ["forbidden"],
 *   },
 * });
 * ```
 *
 * @resource
 * @category CES
 */
export const AppsGuardrail = Resource<AppsGuardrail>("GCP.CES.AppsGuardrail");

export class AppsGuardrailNotResolved extends Data.TaggedError(
  "GCP.CES.AppsGuardrailNotResolved",
)<{
  name: string;
}> {}

const resourceName = (app: string, guardrailId: string) =>
  `${app}/guardrails/${guardrailId}`;

const defaultFilter = (news: AppsGuardrailProps) => {
  if (
    news.contentFilter ||
    news.llmPolicy ||
    news.llmPromptSecurity ||
    news.modelSafety ||
    news.codeCallback
  ) {
    return news.contentFilter;
  }
  return DEFAULT_CONTENT_FILTER;
};

const toAttrs = (
  guardrail: ces.Guardrail,
  project: string,
  region: string,
  appHint?: string,
) => {
  const name = guardrail.name ?? "";
  const parsed = parseResourceName(name, "guardrails", region);
  return {
    name,
    guardrailId: parsed.id,
    app: name.includes("/guardrails/")
      ? parsed.app
      : (appHint ?? parsed.parent),
    location: parsed.location,
    project: parsed.project || project,
    displayName: guardrail.displayName,
    description: parseOwnership(guardrail.description).text,
    enabled: guardrail.enabled !== false,
    contentFilter: guardrail.contentFilter,
    llmPolicy: guardrail.llmPolicy,
    llmPromptSecurity: guardrail.llmPromptSecurity,
    modelSafety: guardrail.modelSafety,
    codeCallback: guardrail.codeCallback,
    action: guardrail.action,
    createTime: guardrail.createTime,
    updateTime: guardrail.updateTime,
    etag: guardrail.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ces
        .getProjectsLocationsAppsGuardrails({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  collectPages(
    ces.listProjectsLocationsAppsGuardrails.pages({ parent, pageSize: 100 }),
    (page) => page.guardrails,
  ).pipe(
    Effect.map((guardrails) =>
      guardrails
        .filter((guardrail) => hasOwnershipMarker(guardrail.description))
        .map((guardrail) => toAttrs(guardrail, project, region, parent)),
    ),
  );

export const AppsGuardrailProvider = () =>
  Provider.succeed(AppsGuardrail, {
    stables: [
      "name",
      "guardrailId",
      "app",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.guardrailId ?? output?.guardrailId,
        nextId: news.guardrailId,
        previousParent: olds?.app ?? output?.app,
        nextParent: news.app,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const app = olds?.app
        ? expandApp(olds.app, env.project, location)
        : output?.app;
      const guardrailId = yield* toPhysicalId(
        id,
        olds?.guardrailId,
        output?.guardrailId,
      );
      const name =
        output?.name ??
        (app !== undefined ? resourceName(app, guardrailId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region, app);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* forEachApp(
          env.project,
          (parent) => listAt(parent, env.project, env.region),
          env.region,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const app = expandApp(news.app, env.project, location);
      const guardrailId = yield* toPhysicalId(
        id,
        news.guardrailId,
        output?.guardrailId,
      );
      const name = output?.name ?? resourceName(app, guardrailId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? guardrailId;
      const enabled = news.enabled !== false;
      const contentFilter = defaultFilter(news);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          ces.createProjectsLocationsAppsGuardrails({
            parent: app,
            guardrailId,
            body: {
              displayName,
              description,
              enabled,
              contentFilter,
              llmPolicy: news.llmPolicy,
              llmPromptSecurity: news.llmPromptSecurity,
              modelSafety: news.modelSafety,
              codeCallback: news.codeCallback,
              action: news.action,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppsGuardrailNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const enabledChanged = (current.enabled !== false) !== enabled;
      const filterChanged = !sameJson(current.contentFilter, contentFilter);
      const policyChanged = !sameJson(current.llmPolicy, news.llmPolicy);
      const promptChanged = !sameJson(
        current.llmPromptSecurity,
        news.llmPromptSecurity,
      );
      const safetyChanged = !sameJson(current.modelSafety, news.modelSafety);
      const callbackChanged = !sameJson(
        current.codeCallback,
        news.codeCallback,
      );
      const actionChanged = !sameJson(current.action, news.action);

      if (
        displayChanged ||
        descriptionChanged ||
        enabledChanged ||
        filterChanged ||
        policyChanged ||
        promptChanged ||
        safetyChanged ||
        callbackChanged ||
        actionChanged
      ) {
        current = yield* retryTransient(
          ces.patchProjectsLocationsAppsGuardrails({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              descriptionChanged ? "description" : undefined,
              enabledChanged ? "enabled" : undefined,
              filterChanged ? "content_filter" : undefined,
              policyChanged ? "llm_policy" : undefined,
              promptChanged ? "llm_prompt_security" : undefined,
              safetyChanged ? "model_safety" : undefined,
              callbackChanged ? "code_callback" : undefined,
              actionChanged ? "action" : undefined,
            ),
            body: {
              displayName,
              description,
              enabled,
              contentFilter,
              llmPolicy: news.llmPolicy,
              llmPromptSecurity: news.llmPromptSecurity,
              modelSafety: news.modelSafety,
              codeCallback: news.codeCallback,
              action: news.action,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region, app);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      // `force: true` makes guardrail deletes fail with 500 INTERNAL.
      yield* retryTransient(
        ces.deleteProjectsLocationsAppsGuardrails({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
