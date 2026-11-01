import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as GcpRetry from "@distilled.cloud/gcp/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import { listAlchemyReasoningEngines } from "./ReasoningEngine.ts";
import {
  AiPlatformNotResolved,
  AiPlatformStillExists,
  collectPages,
  encodeDisplayName,
  hasDisplayNameOwnership,
  lastSegment,
  locationParent,
  normalizeLocation,
  ownedById,
  parentBefore,
  parseDisplayName,
  parseResourceName,
} from "./shared.ts";

const COLLECTION = "sandboxEnvironments";

export type SandboxEnvironmentSpec = {
  /** Code execution environment. */
  codeExecutionEnvironment?: {
    machineConfig?: string;
    codeLanguage?: string;
  };
};

export type ReasoningEnginesSandboxEnvironmentProps = {
  /**
   * Parent Reasoning Engine. Full name or engine id. Immutable —
   * changing it replaces the sandbox.
   */
  reasoningEngine: string;
  /**
   * Vertex AI location. Used when `reasoningEngine` is a bare id.
   * Immutable. @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Required by the API. SandboxEnvironment has no labels
   * field, so Alchemy ownership is stored in a compact `[alc …]`
   * displayName prefix for `list` / nuke.
   */
  displayName?: string;
  /**
   * Template name (id under the parent engine) to create from.
   */
  sandboxEnvironmentTemplate?: string;
  /**
   * Snapshot resource name to restore from.
   */
  sandboxEnvironmentSnapshot?: string;
  /**
   * Sandbox spec (code execution environment).
   */
  spec?: SandboxEnvironmentSpec;
  /**
   * TTL (e.g. `"3600s"`). Input only.
   */
  ttl?: string;
  /**
   * Owner identity. A sandbox can only restore snapshots of the same owner.
   */
  owner?: string;
};

export type ReasoningEnginesSandboxEnvironment = Resource<
  "GCP.AIPlatform.ReasoningEnginesSandboxEnvironment",
  ReasoningEnginesSandboxEnvironmentProps,
  {
    /** Full resource name. */
    name: string;
    /** Sandbox id (last path segment). */
    sandboxEnvironmentId: string;
    /** Parent Reasoning Engine resource name. */
    reasoningEngine: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Runtime state. */
    state: string | undefined;
    /** Template name, if created from a template. */
    sandboxEnvironmentTemplate: string | undefined;
    /** Latest snapshot resource name. */
    latestSandboxEnvironmentSnapshot: string | undefined;
    /** Load-balancer hostname. */
    loadBalancerHostname: string | undefined;
    /** RFC3339 expire time. */
    expireTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI sandbox environment — a containerized secure execution
 * runtime for Agent Engine workloads.
 *
 * There is no update API. Changing parent or location replaces the
 * sandbox. Ownership is stamped into the display name.
 *
 * ### Creating a Sandbox
 * **Example:** From a template
 * ```typescript
 * const sandbox = yield* GCP.AIPlatform.ReasoningEnginesSandboxEnvironment(
 *   "Box",
 *   {
 *     reasoningEngine: engine.name,
 *     displayName: "dev-box",
 *     sandboxEnvironmentTemplate: template.sandboxEnvironmentTemplateId,
 *     ttl: "3600s",
 *   },
 * );
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const ReasoningEnginesSandboxEnvironment =
  Resource<ReasoningEnginesSandboxEnvironment>(
    "GCP.AIPlatform.ReasoningEnginesSandboxEnvironment",
  );

export class ReasoningEnginesSandboxEnvironmentNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.ReasoningEnginesSandboxEnvironmentNotResolved",
)<{
  name: string;
}> {}

const engineNameOf = (
  project: string,
  location: string,
  reasoningEngine: string,
) =>
  reasoningEngine.includes("/")
    ? reasoningEngine
    : `${locationParent(project, location)}/reasoningEngines/${reasoningEngine}`;

const toAttrs = (
  sandbox: aiplatform.GoogleCloudAiplatformV1SandboxEnvironment,
  project: string,
) => {
  const name = sandbox.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  const display = parseDisplayName(sandbox.displayName);
  return {
    name,
    sandboxEnvironmentId: parsed.id,
    reasoningEngine: parentBefore(name, COLLECTION),
    project: parsed.project || project,
    location: parsed.location,
    displayName: display.displayName,
    state: sandbox.state,
    sandboxEnvironmentTemplate: sandbox.sandboxEnvironmentTemplate,
    latestSandboxEnvironmentSnapshot: sandbox.latestSandboxEnvironmentSnapshot,
    loadBalancerHostname: sandbox.connectionInfo?.loadBalancerHostname,
    expireTime: sandbox.expireTime,
    createTime: sandbox.createTime,
    updateTime: sandbox.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform.getReasoningEnginesSandboxEnvironments({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("SandboxEnvironmentsNotEnabled", () =>
          Effect.succeed(undefined),
        ),
      );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (
        sandbox,
      ): sandbox is aiplatform.GoogleCloudAiplatformV1SandboxEnvironment =>
        sandbox !== undefined,
      () => new AiPlatformNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.NotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (sandbox) => sandbox === undefined,
      () => new AiPlatformStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.StillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listSandboxes = (parent: string) =>
  collectPages(
    aiplatform.listReasoningEnginesSandboxEnvironments.pages({
      parent,
      pageSize: 100,
    }),
  ).pipe(
    Effect.map((pages) =>
      pages.flatMap((page) => page.sandboxEnvironments ?? []),
    ),
    Effect.catchTag("NotFound", () =>
      Effect.succeed<aiplatform.GoogleCloudAiplatformV1SandboxEnvironment[]>(
        [],
      ),
    ),
  );

const findOwned = (parent: string, id: string) =>
  Effect.gen(function* () {
    const sandboxes = yield* listSandboxes(parent);
    for (const sandbox of sandboxes) {
      const parsed = parseDisplayName(sandbox.displayName);
      if (yield* ownedById(id, parsed.labels)) {
        return sandbox;
      }
    }
    return undefined;
  });

export const ReasoningEnginesSandboxEnvironmentProvider = () =>
  Provider.succeed(ReasoningEnginesSandboxEnvironment, {
    stables: [
      "name",
      "sandboxEnvironmentId",
      "reasoningEngine",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousParent = lastSegment(
        olds?.reasoningEngine ?? output?.reasoningEngine ?? "",
      );
      const nextParent = lastSegment(news.reasoningEngine);
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const templateChanged =
        (news.sandboxEnvironmentTemplate ?? "") !==
        (olds?.sandboxEnvironmentTemplate ?? "");
      const replace =
        (previousParent.length > 0 && previousParent !== nextParent) ||
        previousLocation !== nextLocation ||
        (olds !== undefined && templateChanged);
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation && previousParent === nextParent,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const parentRef = olds?.reasoningEngine ?? output?.reasoningEngine;
      // A create interrupted before its parent resolved has nothing to find.
      if (output?.name === undefined && typeof parentRef !== "string") {
        return undefined;
      }
      const parent = engineNameOf(env.project, location, parentRef ?? "");
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : yield* findOwned(parent, id);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseDisplayName(existing.displayName);
      return (yield* ownedById(id, parsed.labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const engines = (yield* Effect.forEach(
          listLocations(env.region),
          (location) => listAlchemyReasoningEngines(env.project, location),
        )).flat();
        const sandboxes = yield* Effect.forEach(
          engines,
          (engine) =>
            engine.name
              ? listSandboxes(engine.name)
              : Effect.succeed<
                  aiplatform.GoogleCloudAiplatformV1SandboxEnvironment[]
                >([]),
          { concurrency: 4 },
        );
        return sandboxes
          .flat()
          .filter((sandbox) => hasDisplayNameOwnership(sandbox.displayName))
          .map((sandbox) => toAttrs(sandbox, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = engineNameOf(env.project, location, news.reasoningEngine);
      const internal = yield* createInternalLabels(id);
      const displayName = encodeDisplayName(
        internal,
        news.displayName ?? "sandbox",
      );

      let current =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : yield* findOwned(parent, id);

      if (current === undefined) {
        const created = yield* aiplatform
          .createReasoningEnginesSandboxEnvironments({
            parent,
            body: {
              displayName,
              sandboxEnvironmentTemplate: news.sandboxEnvironmentTemplate,
              sandboxEnvironmentSnapshot: news.sandboxEnvironmentSnapshot,
              spec: news.spec,
              ttl: news.ttl,
              owner: news.owner,
            },
          })
          .pipe(
            GcpRetry.none,
            Effect.catchTag("SandboxEnvironmentsNotEnabled", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
            Effect.timeoutOption("20 seconds"),
          );
        const createdOp = Option.getOrUndefined(created);
        if (createdOp !== undefined) {
          yield* waitForOperation(createdOp, { alreadyExistsOk: true });
        }
        const createdName =
          createdOp !== undefined
            ? resourceNameFromOperation(createdOp)
            : undefined;
        current =
          createdName !== undefined
            ? yield* waitUntilExists(createdName)
            : yield* findOwned(parent, id);
      }

      if (current === undefined || current.name === undefined) {
        return yield* new ReasoningEnginesSandboxEnvironmentNotResolved({
          name: output?.name ?? parent,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteReasoningEnginesSandboxEnvironments({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
