import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  listAgents,
  listFlows,
  listPagesAt,
  ownedByAlchemy,
  ownershipLabels,
  ownershipText,
  parseOwnership,
  parseResourceName,
  sameJson,
  sameText,
  updateMaskOf,
  retryQuota,
} from "./internal.ts";

export type PageFulfillment = {
  /** Response messages. */
  messages?: Array<{
    text?: { text?: string[]; allowPlaybackInterruption?: boolean };
  }>;
  /** Return to the calling page. */
  returnPartialResponses?: boolean;
  /** Tag passed to a webhook. */
  tag?: string;
};

export type AgentsFlowsPageProps = {
  /**
   * Parent flow resource name
   * `projects/{project}/locations/{location}/agents/{agent}/flows/{flow}`.
   * Immutable — changing it replaces the page.
   */
  flow: string;
  /**
   * Page id (the `{page}` segment). Server-assigned on create. Immutable
   * — changing it replaces the page.
   */
  pageId?: string;
  /** Human-readable name, unique within the flow. */
  displayName?: string;
  /**
   * Description. Pages have no labels field, so Alchemy stamps ownership
   * into this field for `list` / nuke.
   */
  description?: string;
  /** Fulfillment run when the page is entered. */
  entryFulfillment?: PageFulfillment;
  /** Language code of the page. */
  languageCode?: string;
};

export type AgentsFlowsPage = Resource<
  "GCP.Dialogflow.AgentsFlowsPage",
  AgentsFlowsPageProps,
  {
    /** Full resource name. */
    name: string;
    /** Page id (last path segment). */
    pageId: string;
    /** Parent flow resource name. */
    flow: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX page under a flow.
 *
 * Pages have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. Parent flow and page id are
 * immutable. Display name, description, and entry fulfillment update
 * in place.
 *
 * ### Creating a Page
 * **Example:** Greeting page
 * ```typescript
 * const page = yield* GCP.Dialogflow.AgentsFlowsPage("Greeting", {
 *   flow: flow.name,
 *   displayName: "greeting",
 *   description: "welcome the user",
 * });
 * ```
 *
 * ### Updating a Page
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename
 * ```typescript
 * const page = yield* GCP.Dialogflow.AgentsFlowsPage("Greeting", {
 *   flow: flow.name,
 *   displayName: "welcome",
 *   description: "welcome the user",
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsFlowsPage = Resource<AgentsFlowsPage>(
  "GCP.Dialogflow.AgentsFlowsPage",
);

export class AgentsFlowsPageNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsFlowsPageNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  page: dialogflow.GoogleCloudDialogflowCxV3Page,
  project: string,
) => {
  const name = page.name ?? "";
  const parsed = parseResourceName(name, "pages");
  return {
    name,
    pageId: parsed.id,
    flow: parsed.flow || parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: page.displayName,
    description: parseOwnership(page.description).text,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsFlowsPages({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (id: string, flow: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const pages = yield* listPagesAt(flow);
    for (const page of pages) {
      if (yield* ownedByAlchemy(id, ownershipText(page))) return page;
    }
    return undefined as dialogflow.GoogleCloudDialogflowCxV3Page | undefined;
  });

const listOwned = (project: string) =>
  Effect.gen(function* () {
    const agents = yield* listAgents(project);
    const flows = (yield* Effect.forEach(
      agents,
      (agent) => (agent.name ? listFlows(agent.name) : Effect.succeed([])),
      { concurrency: 4 },
    )).flat();
    const pages = (yield* Effect.forEach(
      flows,
      (flow) => (flow.name ? listPagesAt(flow.name) : Effect.succeed([])),
      { concurrency: 4 },
    )).flat();
    return pages
      .filter(
        (page) =>
          parseOwnership(page.description).labels["alchemy-id"] !== undefined ||
          parseOwnership(page.displayName).labels["alchemy-id"] !== undefined,
      )
      .map((page) => toAttrs(page, project));
  });

export const AgentsFlowsPageProvider = () =>
  Provider.succeed(AgentsFlowsPage, {
    stables: ["name", "pageId", "flow", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousFlow = olds?.flow ?? output?.flow;
      const previousId = olds?.pageId ?? output?.pageId;
      if (
        (previousFlow !== undefined && news.flow !== previousFlow) ||
        (previousId !== undefined &&
          news.pageId !== undefined &&
          news.pageId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousFlow === news.flow &&
            previousId !== undefined &&
            news.pageId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const flow = olds?.flow ?? output?.flow;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : flow !== undefined
            ? yield* findOwned(id, flow)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const flow = news.flow;
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? "page";
      const body: dialogflow.GoogleCloudDialogflowCxV3Page = {
        displayName,
        description,
        entryFulfillment: news.entryFulfillment,
      };

      let current = yield* findOwned(id, flow, output?.name);

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsFlowsPages({
            parent: flow,
            languageCode: news.languageCode,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, flow, output?.name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsFlowsPageNotResolved({
          name: output?.name ?? `${flow}/pages/${news.pageId ?? "unknown"}`,
        });
      }

      const currentName = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const fulfillmentChanged = !sameJson(
        current.entryFulfillment,
        news.entryFulfillment,
      );

      if (displayChanged || descriptionChanged || fulfillmentChanged) {
        current = yield* dialogflow.patchProjectsLocationsAgentsFlowsPages({
          name: currentName,
          languageCode: news.languageCode,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
            fulfillmentChanged ? "entry_fulfillment" : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsFlowsPages({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
