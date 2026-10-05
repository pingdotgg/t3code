import * as bigqueryreservation from "@distilled.cloud/gcp/bigqueryreservation_v1";
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
  compact,
  hasOwnershipMarker,
  lastSegment,
  listLocations,
  normalizeLocation,
  ownedByAlchemy,
  parentOf,
  toResourceId,
} from "./internal.ts";

export type AssignmentJobType =
  | bigqueryreservation.AssignmentJobTypeEnum
  | (string & {});

export type AssignmentSchedulingPolicy = {
  /**
   * Soft per-project slot cap for jobs in this assignment. Preview.
   */
  maxSlots?: string;
  /**
   * Soft per-project job concurrency cap. Preview.
   */
  concurrency?: string;
};

export type AssignmentProps = {
  /**
   * Parent reservation resource name
   * `projects/{project}/locations/{location}/reservations/{reservation}`
   * or a bare reservation id (resolved in the current project and
   * `location`). Immutable — changing it replaces the assignment.
   */
  reservation: string;
  /**
   * Resource that consumes the reservation: `projects/{project}`,
   * `folders/{folder}`, or `organizations/{org}`. Defaults to the
   * current GCP project. Immutable — changing it replaces the
   * assignment. One assignment per `(assignee, jobType, location)`.
   */
  assignee?: string;
  /**
   * Job type that uses the reservation (`QUERY`, `PIPELINE`,
   * `ML_EXTERNAL`, `BACKGROUND`, `CONTINUOUS`, …). Immutable —
   * changing it replaces the assignment.
   * @default "QUERY"
   */
  jobType?: AssignmentJobType;
  /**
   * Assignment id (the `{assignment}` segment). If omitted, a unique
   * name is generated. Assignments have no labels field, so Alchemy
   * stamps ownership into this id (`alch---…`) for `list` / nuke.
   * Immutable — changing it replaces the assignment. Max 64
   * characters, lowercase letters, digits, or dashes.
   */
  assignmentId?: string;
  /**
   * Location of the parent reservation. Used when `reservation` is a
   * bare id. Immutable — changing it replaces the assignment.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Principal that must run jobs to use this assignment. When empty,
   * any job of `jobType` on `assignee` uses the reservation.
   */
  principal?: string;
  /**
   * Per-assignment scheduling policy. Preview.
   */
  schedulingPolicy?: AssignmentSchedulingPolicy;
};

export type Assignment = Resource<
  "GCP.BigQueryReservation.Assignment",
  AssignmentProps,
  {
    /** Full resource name `…/reservations/{reservation}/assignments/{assignment}`. */
    name: string;
    /** Assignment id (last path segment). */
    assignmentId: string;
    /** Parent reservation resource name. */
    reservation: string;
    /** Reservation id. */
    reservationId: string;
    /** Project that owns the reservation. */
    project: string;
    /** Location id. */
    location: string;
    /** Assignee resource (`projects/…`, `folders/…`, `organizations/…`). */
    assignee: string | undefined;
    /** Job type. */
    jobType: string | undefined;
    /** Assignment state (`PENDING`, `ACTIVE`). */
    state: string | undefined;
    /** Principal, if set. */
    principal: string | undefined;
    /** Scheduling policy, if set. */
    schedulingPolicy: bigqueryreservation.SchedulingPolicy | undefined;
  },
  never,
  Providers
>;

/**
 * A BigQuery reservation assignment — grants a project, folder, or
 * organization slots from a {@link Reservation} for one job type.
 *
 * Assignments have no labels. Alchemy stamps ownership into
 * `assignmentId` so `list` / `pnpm nuke:gcp` can find them. Changing
 * `reservation`, `assignee`, `jobType`, `location`, or `assignmentId`
 * replaces the assignment. `principal` and `schedulingPolicy` update
 * in place.
 *
 * ### Creating an Assignment
 * **Example:** Assign QUERY jobs in this project
 * ```typescript
 * const slots = yield* GCP.BigQueryReservation.Reservation("Slots", {});
 * const assignment = yield* GCP.BigQueryReservation.Assignment("Query", {
 *   reservation: slots.name,
 *   jobType: "QUERY",
 * });
 * ```
 *
 * **Example:** None assignment (on-demand)
 * ```typescript
 * const none = yield* GCP.BigQueryReservation.Assignment("OnDemand", {
 *   reservation: "none",
 *   location: "US",
 *   jobType: "QUERY",
 * });
 * ```
 *
 * @resource
 * @category BigQueryReservation
 */
export const Assignment = Resource<Assignment>(
  "GCP.BigQueryReservation.Assignment",
);

export class AssignmentNotResolved extends Data.TaggedError(
  "GCP.BigQueryReservation.AssignmentNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_JOB_TYPE = "QUERY";

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const after = (segment: string) => {
    const at = parts.lastIndexOf(segment);
    return at >= 0 && parts[at + 1] ? parts[at + 1]! : "";
  };
  const reservationId = after("reservations");
  const location = after("locations");
  const project = after("projects");
  return {
    project,
    location,
    reservationId,
    assignmentId: after("assignments") || lastSegment(name),
    reservation:
      project && location && reservationId
        ? `projects/${project}/locations/${location}/reservations/${reservationId}`
        : "",
  };
};

const reservationParent = (
  project: string,
  location: string,
  reservation: string,
) => {
  if (reservation.includes("/reservations/")) {
    const parsed = parseName(
      reservation.endsWith("/assignments")
        ? reservation
        : `${reservation}/assignments/_`,
    );
    return `projects/${parsed.project || project}/locations/${parsed.location || location}/reservations/${parsed.reservationId || lastSegment(reservation)}`;
  }
  return `projects/${project}/locations/${location}/reservations/${lastSegment(reservation)}`;
};

const assigneeOf = (project: string, assignee: string | undefined) =>
  assignee && assignee.length > 0 ? assignee : `projects/${project}`;

const jobTypeOf = (jobType: string | undefined) =>
  (jobType ?? DEFAULT_JOB_TYPE).toUpperCase();

const jsonOf = (value: unknown) => JSON.stringify(value ?? null);

const desiredSchedulingPolicy = (
  news: AssignmentProps,
): bigqueryreservation.SchedulingPolicy | undefined =>
  news.schedulingPolicy === undefined
    ? undefined
    : compact({
        maxSlots: news.schedulingPolicy.maxSlots,
        concurrency: news.schedulingPolicy.concurrency,
      });

const toAttrs = (
  current: bigqueryreservation.Assignment,
  fallbackProject: string,
) => {
  const name = current.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    assignmentId: parsed.assignmentId,
    reservation: parsed.reservation,
    reservationId: parsed.reservationId,
    project: parsed.project || fallbackProject,
    location: parsed.location,
    assignee: current.assignee,
    jobType: current.jobType,
    state: current.state,
    principal: current.principal,
    schedulingPolicy: current.schedulingPolicy,
  };
};

const listAt = (parent: string) =>
  parent.length === 0
    ? Effect.succeed([] as bigqueryreservation.Assignment[])
    : bigqueryreservation.listProjectsLocationsReservationsAssignments
        .pages({ parent, pageSize: 1000 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.assignments ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as bigqueryreservation.Assignment[]),
          ),
        );

const getByName = (name: string) => {
  if (name.length === 0) return Effect.succeed(undefined);
  const parent = parseName(name).reservation;
  return listAt(parent).pipe(
    Effect.map((assignments) => assignments.find((item) => item.name === name)),
  );
};

const findExisting = (
  parent: string,
  assignee: string,
  jobType: string,
  assignmentId?: string,
) =>
  listAt(parent).pipe(
    Effect.map((assignments) =>
      assignments.find((item) => {
        if (assignmentId && lastSegment(item.name ?? "") === assignmentId) {
          return true;
        }
        return (
          (item.assignee ?? "") === assignee &&
          jobTypeOf(item.jobType) === jobType
        );
      }),
    ),
  );

export const AssignmentProvider = () =>
  Provider.succeed(Assignment, {
    stables: [
      "name",
      "assignmentId",
      "reservation",
      "reservationId",
      "project",
      "location",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousReservation = olds?.reservation ?? output?.reservation;
      const previousAssignee = olds?.assignee ?? output?.assignee;
      const previousJobType = jobTypeOf(olds?.jobType ?? output?.jobType);
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const previousId = olds?.assignmentId ?? output?.assignmentId;
      const nextJobType = jobTypeOf(news.jobType ?? previousJobType);
      const nextLocation = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      if (
        (previousReservation !== undefined &&
          news.reservation !== previousReservation) ||
        (previousAssignee !== undefined &&
          news.assignee !== undefined &&
          news.assignee !== previousAssignee) ||
        previousJobType !== nextJobType ||
        previousLocation !== nextLocation ||
        (previousId !== undefined &&
          news.assignmentId !== undefined &&
          news.assignmentId !== previousId)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const parent = reservationParent(
        env.project,
        location,
        olds?.reservation ?? output?.reservation ?? "",
      );
      const assignmentId = yield* toResourceId(
        id,
        olds?.assignmentId,
        output?.assignmentId,
      );
      const name =
        output?.name ?? (parent ? `${parent}/assignments/${assignmentId}` : "");
      const existing =
        (yield* getByName(name)) ??
        (yield* findExisting(
          parent,
          assigneeOf(env.project, olds?.assignee ?? output?.assignee),
          jobTypeOf(olds?.jobType ?? output?.jobType),
          assignmentId,
        ));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, attrs.assignmentId))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            listAt(`${parentOf(env.project, location)}/reservations/-`).pipe(
              Effect.map((assignments) =>
                assignments
                  .filter((item) =>
                    hasOwnershipMarker(lastSegment(item.name ?? "")),
                  )
                  .map((item) => toAttrs(item, env.project)),
              ),
            ),
          { concurrency: 4 },
        );
        const byName = new Map<string, ReturnType<typeof toAttrs>>();
        for (const item of pages.flat()) {
          byName.set(item.name, item);
        }
        return Array.from(byName.values());
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const parent = reservationParent(env.project, location, news.reservation);
      const assignmentId = yield* toResourceId(
        id,
        news.assignmentId,
        output?.assignmentId,
      );
      const name = `${parent}/assignments/${assignmentId}`;
      const assignee = assigneeOf(env.project, news.assignee);
      const jobType = jobTypeOf(news.jobType);
      const body = compact({
        assignee,
        jobType,
        principal: news.principal,
        schedulingPolicy: desiredSchedulingPolicy(news),
      });

      let current =
        (yield* getByName(output?.name ?? name)) ??
        (yield* findExisting(parent, assignee, jobType, assignmentId));

      if (current === undefined) {
        const created = yield* bigqueryreservation
          .createProjectsLocationsReservationsAssignments({
            parent,
            assignmentId,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findExisting(parent, assignee, jobType, assignmentId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AssignmentNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const principalChanged =
        news.principal !== undefined &&
        (current.principal ?? "") !== news.principal;
      const schedulingChanged =
        news.schedulingPolicy !== undefined &&
        jsonOf(current.schedulingPolicy) !==
          jsonOf(desiredSchedulingPolicy(news));
      const updateMask = [
        principalChanged ? "principal" : undefined,
        schedulingChanged ? "schedulingPolicy" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current =
          yield* bigqueryreservation.patchProjectsLocationsReservationsAssignments(
            {
              name: currentName,
              updateMask: updateMask.join(","),
              body,
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* bigqueryreservation
        .deleteProjectsLocationsReservationsAssignments({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
