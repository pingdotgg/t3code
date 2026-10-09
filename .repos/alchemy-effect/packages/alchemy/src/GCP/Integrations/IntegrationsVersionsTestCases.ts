import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type IntegrationsVersionsTestCasesProps = {
  /**
   * Parent integration version resource name
   * `projects/{project}/locations/{location}/integrations/{integration}/versions/{version}`.
   * Immutable — changing it replaces the test case.
   */
  version: string;
  /**
   * Test case id (the `{testCase}` segment). If omitted, a unique id is
   * generated. Immutable — changing it replaces the test case.
   */
  testCaseId?: string;
  /**
   * Location used when `version` is a bare id. Immutable — changing it
   * replaces the test case.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name.
   */
  displayName?: string;
  /**
   * Human-readable description. Test cases have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Trigger id in the parent version that starts this test case
   * (`api_trigger/{name}`).
   */
  triggerId: string;
};

export type IntegrationsVersionsTestCases = Resource<
  "GCP.Integrations.IntegrationsVersionsTestCases",
  IntegrationsVersionsTestCasesProps,
  {
    /** Full resource name. */
    name: string;
    /** Test case id (last path segment). */
    testCaseId: string;
    /** Parent version resource name. */
    version: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Trigger id this test case starts from. */
    triggerId: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A functional test case attached to an Application Integration version.
 *
 * Test cases have no labels field — Alchemy stamps ownership into the
 * description. Parent version and test case id are immutable. Display
 * name, description, and trigger id update in place.
 *
 * ### Creating a Test Case
 * **Example:** Exercise an API trigger
 * ```typescript
 * const testCase = yield* GCP.Integrations.IntegrationsVersionsTestCases("HappyPath", {
 *   version: version.name,
 *   triggerId: "api_trigger/orders",
 *   displayName: "happy-path",
 *   description: "fires the API trigger",
 * });
 * ```
 *
 * @resource
 * @category Integrations
 */
export const IntegrationsVersionsTestCases =
  Resource<IntegrationsVersionsTestCases>(
    "GCP.Integrations.IntegrationsVersionsTestCases",
  );

export class IntegrationsVersionsTestCasesNotResolved extends Data.TaggedError(
  "GCP.Integrations.IntegrationsVersionsTestCasesNotResolved",
)<{
  name: string;
}> {}

const expandVersion = (value: string, project: string, location: string) =>
  value.includes("/versions/")
    ? value
    : `${locationParent(project, location)}/integrations/${value}/versions/${value}`;

const resourceName = (version: string, testCaseId: string) =>
  `${version}/testCases/${testCaseId}`;

const toAttrs = (
  testCase: integrations.GoogleCloudIntegrationsV1alphaTestCase,
  project: string,
  region: string,
  version: string,
) => {
  const name = testCase.name ?? "";
  const parsed = parseOwnership(testCase.description);
  return {
    name,
    testCaseId: lastSegment(name),
    version,
    location: locationOf(name, region),
    project,
    displayName: testCase.displayName,
    description: parsed.text,
    triggerId: testCase.triggerId,
    createTime: testCase.createTime,
    updateTime: testCase.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : integrations
        .getProjectsLocationsIntegrationsVersionsTestCases({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  integrations.listProjectsLocationsIntegrationsVersionsTestCases
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.testCases ?? [])),
      Stream.filter((testCase) => hasOwnershipMarker(testCase.description)),
      Stream.map((testCase) => toAttrs(testCase, project, region, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (parent: string, id: string) =>
  integrations.listProjectsLocationsIntegrationsVersionsTestCases
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.testCases ?? [])),
      Stream.filterEffect((testCase) =>
        ownedByAlchemy(id, testCase.description),
      ),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

const listWildcard = (project: string, location: string) =>
  listAt(
    `${locationParent(project, location)}/integrations/-/versions/-`,
    project,
    location,
  );

export const IntegrationsVersionsTestCasesProvider = () =>
  Provider.succeed(IntegrationsVersionsTestCases, {
    stables: [
      "name",
      "testCaseId",
      "version",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousVersion = olds?.version ?? output?.version;
      if (
        previousVersion !== undefined &&
        news.version !== previousVersion &&
        !news.version.endsWith(`/${lastSegment(previousVersion)}`)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.testCaseId ?? output?.testCaseId;
      if (
        previousId !== undefined &&
        news.testCaseId !== undefined &&
        news.testCaseId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const version = expandVersion(
        olds?.version ?? output?.version ?? "",
        env.project,
        location,
      );
      const testCaseId = yield* toResourceId(
        id,
        olds?.testCaseId,
        output?.testCaseId,
      );
      const name = output?.name ?? resourceName(version, testCaseId);
      let existing = yield* getByName(name);
      if (existing === undefined && version.length > 0) {
        existing = yield* findOwned(version, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region, version);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listWildcard(env.project, env.region);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const version = expandVersion(news.version, env.project, location);
      const testCaseId = yield* toResourceId(
        id,
        news.testCaseId,
        output?.testCaseId,
      );
      const name = output?.name ?? resourceName(version, testCaseId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? testCaseId;

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findOwned(version, id);
      }

      if (current === undefined) {
        const created = yield* integrations
          .createProjectsLocationsIntegrationsVersionsTestCases({
            parent: version,
            testCaseId,
            body: {
              displayName,
              description,
              triggerId: news.triggerId,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(version, id)));
        current = created ?? (yield* findOwned(version, id));
      }

      if (current === undefined) {
        return yield* new IntegrationsVersionsTestCasesNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const triggerChanged = !sameText(current.triggerId, news.triggerId);

      if (displayChanged || descriptionChanged || triggerChanged) {
        current =
          yield* integrations.patchProjectsLocationsIntegrationsVersionsTestCases(
            {
              name: currentName,
              updateMask: updateMaskOf(
                displayChanged ? "display_name" : undefined,
                descriptionChanged ? "description" : undefined,
                triggerChanged ? "trigger_id" : undefined,
              ),
              body: {
                name: currentName,
                displayName,
                description,
                triggerId: news.triggerId,
              },
            },
          );
      }

      return toAttrs(current, env.project, env.region, version);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* integrations
        .deleteProjectsLocationsIntegrationsVersionsTestCases({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
