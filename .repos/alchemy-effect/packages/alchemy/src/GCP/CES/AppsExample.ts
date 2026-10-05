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

export type AppsExampleProps = {
  /**
   * Parent CES app. Full name
   * `projects/{project}/locations/{location}/apps/{app}` or the app id
   * (combined with `location`). Immutable — changing it replaces the
   * example.
   */
  app: string;
  /**
   * Region used when `app` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Example id. If omitted, a unique name is generated. Immutable —
   * changing it replaces the example.
   */
  exampleId?: string;
  /**
   * Human-readable name. Required by the API; Alchemy falls back to the
   * generated example id.
   */
  displayName?: string;
  /**
   * Human-readable description. Examples have no labels field, so
   * Alchemy stamps ownership into this field.
   */
  description?: string;
  /**
   * Entry agent resource name. When omitted, the root agent handles the
   * conversation.
   */
  entryAgent?: string;
  /**
   * Conversation messages that make up the example.
   */
  messages?: ces.MessageList;
};

export type AppsExample = Resource<
  "GCP.CES.AppsExample",
  AppsExampleProps,
  {
    /** Full resource name `.../apps/{app}/examples/{example}`. */
    name: string;
    /** Example id (last path segment). */
    exampleId: string;
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
    /** Entry agent resource name. */
    entryAgent: string | undefined;
    /** Conversation messages. */
    messages: ces.MessageList | undefined;
    /** Whether the example is invalid. */
    invalid: boolean | undefined;
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
 * A Customer Engagement Suite few-shot example conversation inside an
 * app.
 *
 * Examples have no labels field — Alchemy stamps ownership into
 * `description` so `list` / nuke can find them. Parent app, location,
 * and example id are immutable.
 *
 * ### Creating an Example
 * **Example:** Greeting transcript
 * ```typescript
 * const example = yield* GCP.CES.AppsExample("Hello", {
 *   app: app.name,
 *   displayName: "hello",
 *   messages: [
 *     { role: "user", chunks: [{ text: "Hi" }] },
 *     { role: "agent", chunks: [{ text: "Hello! How can I help?" }] },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category CES
 */
export const AppsExample = Resource<AppsExample>("GCP.CES.AppsExample");

export class AppsExampleNotResolved extends Data.TaggedError(
  "GCP.CES.AppsExampleNotResolved",
)<{
  name: string;
}> {}

const resourceName = (app: string, exampleId: string) =>
  `${app}/examples/${exampleId}`;

const toAttrs = (
  example: ces.Example,
  project: string,
  region: string,
  appHint?: string,
) => {
  const name = example.name ?? "";
  const parsed = parseResourceName(name, "examples", region);
  return {
    name,
    exampleId: parsed.id,
    app: name.includes("/examples/") ? parsed.app : (appHint ?? parsed.parent),
    location: parsed.location,
    project: parsed.project || project,
    displayName: example.displayName,
    description: parseOwnership(example.description).text,
    entryAgent: example.entryAgent,
    messages: example.messages,
    invalid: example.invalid,
    createTime: example.createTime,
    updateTime: example.updateTime,
    etag: example.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ces
        .getProjectsLocationsAppsExamples({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  collectPages(
    ces.listProjectsLocationsAppsExamples.pages({ parent, pageSize: 100 }),
    (page) => page.examples,
  ).pipe(
    Effect.map((examples) =>
      examples
        .filter((example) => hasOwnershipMarker(example.description))
        .map((example) => toAttrs(example, project, region, parent)),
    ),
  );

export const AppsExampleProvider = () =>
  Provider.succeed(AppsExample, {
    stables: ["name", "exampleId", "app", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.exampleId ?? output?.exampleId,
        nextId: news.exampleId,
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
      const exampleId = yield* toPhysicalId(
        id,
        olds?.exampleId,
        output?.exampleId,
      );
      const name =
        output?.name ?? (app !== undefined ? resourceName(app, exampleId) : "");
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
      const exampleId = yield* toPhysicalId(
        id,
        news.exampleId,
        output?.exampleId,
      );
      const name = output?.name ?? resourceName(app, exampleId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? exampleId;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          ces.createProjectsLocationsAppsExamples({
            parent: app,
            exampleId,
            body: {
              displayName,
              description,
              entryAgent: news.entryAgent,
              messages: news.messages,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppsExampleNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const entryChanged = !sameText(current.entryAgent, news.entryAgent);
      const messagesChanged = !sameJson(current.messages, news.messages);

      if (
        displayChanged ||
        descriptionChanged ||
        entryChanged ||
        messagesChanged
      ) {
        current = yield* retryTransient(
          ces.patchProjectsLocationsAppsExamples({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              descriptionChanged ? "description" : undefined,
              entryChanged ? "entry_agent" : undefined,
              messagesChanged ? "messages" : undefined,
            ),
            body: {
              displayName,
              description,
              entryAgent: news.entryAgent,
              messages: news.messages,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region, app);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        ces.deleteProjectsLocationsAppsExamples({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
