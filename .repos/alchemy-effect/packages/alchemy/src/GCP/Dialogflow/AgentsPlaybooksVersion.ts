import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectionParent,
  encodeOwnership,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  locationOf,
  namedAgents,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
  projectOf,
  toResourceId,
  retryQuota,
} from "./internal.ts";

export type AgentsPlaybooksVersionProps = {
  /**
   * Parent playbook resource name
   * `projects/{project}/locations/{location}/agents/{agent}/playbooks/{playbook}`.
   * Immutable — changing it replaces the version.
   */
  playbook: string;
  /**
   * Version id (the `{version}` segment). Server-assigned when omitted.
   * Immutable — changing it replaces the version.
   */
  versionId?: string;
  /**
   * Snapshot description. Playbook versions have no labels field, so
   * Alchemy stamps ownership into this field and strips it from
   * attributes. Versions are immutable snapshots — changing the
   * description after create is a no-op.
   */
  description?: string;
};

export type AgentsPlaybooksVersion = Resource<
  "GCP.Dialogflow.AgentsPlaybooksVersion",
  AgentsPlaybooksVersionProps,
  {
    /** Full resource name `.../playbooks/{playbook}/versions/{version}`. */
    name: string;
    /** Version id (last path segment). */
    versionId: string;
    /** Parent playbook resource name. */
    playbook: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** RFC3339 snapshot timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX playbook version (immutable snapshot of a playbook).
 *
 * Versions have no labels field and no update RPC — Alchemy stamps
 * ownership into `description` so `list` / nuke can find them. Reconcile
 * is observe-ensure: if the snapshot is missing it is created; later
 * description edits are ignored.
 *
 * ### Creating a Playbook Version
 * **Example:** Snapshot
 * ```typescript
 * const version = yield* GCP.Dialogflow.AgentsPlaybooksVersion("v1", {
 *   playbook: playbook.name,
 *   description: "initial",
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsPlaybooksVersion = Resource<AgentsPlaybooksVersion>(
  "GCP.Dialogflow.AgentsPlaybooksVersion",
);

export class AgentsPlaybooksVersionNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsPlaybooksVersionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (playbook: string, versionId: string) =>
  `${playbook}/versions/${versionId}`;

const toAttrs = (
  version: dialogflow.GoogleCloudDialogflowCxV3PlaybookVersion,
  project: string,
  playbookHint?: string,
) => {
  const name = version.name ?? "";
  return {
    name,
    versionId: lastSegment(name),
    playbook: name.includes("/versions/")
      ? collectionParent(name, "playbooks")
      : (playbookHint ?? parentOf(name)),
    location: locationOf(name),
    project: projectOf(name) || project,
    description: parseOwnership(version.description).text,
    updateTime: version.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsPlaybooksVersions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  dialogflow.listProjectsLocationsAgentsPlaybooksVersions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.playbookVersions ?? []),
      ),
      Stream.filter((version) => hasOwnershipMarker(version.description)),
      Stream.map((version) => toAttrs(version, project, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const listPlaybooks = (agent: string) =>
  dialogflow.listProjectsLocationsAgentsPlaybooks
    .pages({ parent: agent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.playbooks ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDescription = (parent: string, description: string) =>
  dialogflow.listProjectsLocationsAgentsPlaybooksVersions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.playbookVersions ?? []),
      ),
      Stream.filter((version) => version.description === description),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const AgentsPlaybooksVersionProvider = () =>
  Provider.succeed(AgentsPlaybooksVersion, {
    stables: [
      "name",
      "versionId",
      "playbook",
      "location",
      "project",
      "updateTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.playbook ?? output?.playbook;
      if (previousParent !== undefined && news.playbook !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.versionId ?? output?.versionId;
      if (
        previousId !== undefined &&
        news.versionId !== undefined &&
        news.versionId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const playbook = olds?.playbook ?? output?.playbook;
      const name =
        // Version ids are assigned by the server, so only a recorded name can
        // be fetched directly (a guessed id is rejected as malformed).
        output?.name ?? "";
      let existing = yield* getByName(name);
      if (existing === undefined && playbook !== undefined) {
        const ownership = yield* internalLabels(id);
        existing = yield* findByDescription(
          playbook,
          encodeOwnership(ownership, olds?.description),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, playbook);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const agents = yield* namedAgents(env.project);
        const pages = yield* Effect.forEach(
          agents,
          (agent) =>
            Effect.gen(function* () {
              const playbooks = yield* listPlaybooks(agent.name);
              const versions = yield* Effect.forEach(
                playbooks,
                (playbook) =>
                  playbook.name
                    ? listAt(playbook.name, env.project)
                    : Effect.succeed([]),
                { concurrency: 4 },
              );
              return versions.flat();
            }),
          { concurrency: 2 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const playbook = news.playbook;
      const versionId = yield* toResourceId(
        id,
        news.versionId,
        output?.versionId,
      );
      const name = output?.name ?? resourceName(playbook, versionId);
      const ownership = yield* internalLabels(id);
      const description = encodeOwnership(ownership, news.description);

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findByDescription(playbook, description);
      }

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsPlaybooksVersions({
            parent: playbook,
            body: { description },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDescription(playbook, description),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsPlaybooksVersionNotResolved({ name });
      }

      return toAttrs(current, env.project, playbook);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsPlaybooksVersions({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
