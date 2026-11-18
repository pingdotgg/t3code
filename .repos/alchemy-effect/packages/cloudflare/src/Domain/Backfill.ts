import type { Progress } from "@alchemy.run/domain/Backfill";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";

export interface BackfillProps {
  /** The Domain's Worker: a run starts once the Worker carrying its Workflow is deployed. */
  scriptName: string;
  /** The Workflow, hosted by the Domain's Worker, that starts the runs and waits for them. */
  workflowName: string;
  /**
   * Every view and projection in the model, by target id (`view:Name`, with
   * `#<generation>` once rebuilt). Those new to the Domain are backfilled.
   */
  targets: string[];
  /**
   * What the backfill needs to know of each consumer (the sources it reads, and
   * whether a key reads its one source's log itself), by target id. The
   * deploy passes them to each run, so a run doesn't depend on what an
   * object's code knows.
   */
  plans?: Record<string, { sources?: string[]; singleSource: boolean }>;
  /**
   * How long a deploy waits for the backfill, in seconds. Past it the deploy
   * fails, while the backfill keeps running on Cloudflare; the next deploy
   * waits on the same runs.
   * @default 1800
   */
  timeoutSeconds?: number;
}

export interface BackfillAttrs {
  accountId: string;
  workflowName: string;
  /** The Workflow instance the last deploy waited through. */
  instanceId: string;
  targets: string[];
  /** `complete` once every target's run is complete. */
  status: string;
}

const BackfillTypeId = "Cloudflare.Domain.Backfill";

/**
 * The backfill of a Domain's views and projections, run by reconciliation.
 * The Durable Object platform declares it with the model's consumers: you
 * don't declare it yourself. A deploy that adds a view or projection, or
 * bumps a version, waits here until every new consumer has received the
 * history recorded before it, and reports how far each one has got.
 *
 * ### What a deploy waits for <!-- api-prose -->
 *
 * Each consumer generation (a view, or a view after a version bump) has one
 * run, held by one Durable Object of a class only that generation has. The
 * first deploy to reach it starts it; every later start finds it started, so
 * there is never more than one, however many deploys ask. The run lives on
 * Cloudflare and moves on its own: this resource starts it, waits for it,
 * and reports its progress, but holds none of its state.
 *
 * So a deploy is safe to repeat and to interrupt. Run it again after a
 * failure, a timeout or a Ctrl-C, and it waits on the same runs, from where
 * they are; once they are complete it returns at once. A deploy that changes
 * no consumer plans no change here.
 *
 * ### Progress <!-- api-prose -->
 *
 * While it waits, the deploy notes each run's phase and how far through the
 * directory it is:
 *
 * ```sh
 * Backfilling view:Deposits reading history 41% (1,690/4,096 subtrees, 410,211 instances) (48s) ...
 * ```
 *
 * A consumer keyed by its source reads its history in one pass; any other
 * reads it, then applies it once every source's history is in. `refused`
 * counts calls Cloudflare turned down for the account's load: the run backs
 * off and sends them again.
 *
 * ### Rebuilding and cancelling <!-- api-prose -->
 *
 * A run reads the sources its consumer read when it started. A deploy whose
 * consumer reads other sources at the same version (a view that now reads a
 * journal as well as accounts) fails, saying to bump the version: waiting on
 * the run would report a history that misses the new source.
 *
 * To run a backfill again, bump the consumer's version: the new generation is
 * a new class with its own run, and the same Worker upload deletes the old
 * generation's class, data and run. To stop a backfill, remove the consumer
 * from the model and deploy: its classes, and the run with them, are deleted.
 * Either is one Worker upload, so a consumer never has two runs at once.
 *
 * @resource
 * @product Durable Objects
 */
export interface Backfill extends Resource<typeof BackfillTypeId, BackfillProps, BackfillAttrs> {}

export const Backfill = Resource<Backfill>(BackfillTypeId);

export class BackfillStillRunning extends Data.TaggedError("BackfillStillRunning")<{
  readonly message: string;
  readonly instanceId: string;
}> {}

export class BackfillFailed extends Data.TaggedError("BackfillFailed")<{
  readonly message: string;
  readonly instanceId: string;
  readonly status: string;
}> {}

/** The Workflow instance for one deploy's wait: named after the targets, and new each time. */
const instanceIdOf = (targets: ReadonlyArray<string>, resource: string, attempt: string) => {
  let hash = 0x811c9dc5;
  for (const char of [...targets].sort().join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `backfill-${resource.slice(0, 12)}-${hash.toString(16).padStart(8, "0")}-${attempt}`;
};

const POLL = "1 second";
/** How often the deploy reads the runs' progress from the instance's steps. */
const PROGRESS_EVERY = 3;
/** How many times a wait whose instance can't carry it on is started again, and how soon. */
const MAX_RESTARTS = 30;
const RESTART_DELAY = "2 seconds";

/**
 * An instance started on an edge that doesn't have the deployed Worker yet (or
 * its entrypoint, or the consumer's class) stays on the code it started with:
 * a new instance runs the deployed code.
 */
const startedTooSoon = (message: string) =>
  /entrypoint name .* was not found|^Worker not found|isn't in the code this runs yet/.test(
    message,
  );

/**
 * Workflows answers instance calls for a Workflow uploaded moments before with
 * an internal error (code 10001) for a while: call again.
 */
const retryInternal = {
  while: (error: { readonly _tag: string }) => error._tag === "WorkflowInternalError",
  schedule: Schedule.spaced("2 seconds"),
  times: 30,
};

/** Each run's progress from the latest check step's output (an array of {@link Progress}). */
export const progressOf = (steps: ReadonlyArray<object>) => {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (!("output" in step) || typeof step.output !== "string") continue;
    if (!("name" in step) || typeof step.name !== "string" || !step.name.startsWith("check-"))
      continue;
    const found = findProgress(parseJson(step.output));
    if (found !== undefined) return found;
  }
  return undefined;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The first array of runs' progress in a step's output, however the step encoded it. */
const findProgress = (value: unknown): ReadonlyArray<Progress> | undefined => {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => isProgress(item))) return value;
    for (const item of value) {
      const found = findProgress(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) {
      const found = findProgress(item);
      if (found !== undefined) return found;
    }
  if (typeof value === "string" && (value.startsWith("[") || value.startsWith("{")))
    return findProgress(parseJson(value));
  return undefined;
};

const isProgress = (value: unknown): value is Progress =>
  value !== null &&
  typeof value === "object" &&
  "target" in value &&
  "phase" in value &&
  "subtrees" in value;

const count = (n: number) => n.toLocaleString("en-US");

/** One run's progress, as the deploy notes it. */
export const describeProgress = (run: Progress) => {
  if (run.phase === "complete") return `${run.target} complete`;
  if (run.phase === "unknown") return `${run.target} starting`;
  const what = run.phase === "discover" ? "reading history" : "applying history";
  if (run.subtrees === 0) return `${run.target} ${what}`;
  const percent = Math.floor((100 * run.done) / run.subtrees);
  return `${run.target} ${what} ${percent}% (${count(run.done)}/${count(run.subtrees)} subtrees, ${count(run.instances)} instances${run.refused > 0 ? `, ${count(run.refused)} refused` : ""})`;
};

const BackfillLive = () =>
  Provider.succeed(Backfill, {
    stables: ["accountId", "workflowName"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return { action: "update" } as const;
      const changed =
        olds.workflowName !== news.workflowName ||
        [...olds.targets].sort().join("|") !== [...(news.targets ?? [])].sort().join("|");
      if (changed) return { action: "update" } as const;
    }),
    // The runs are the state, and they live on Cloudflare: what was recorded stands
    // until a deploy changes the targets (an instance Workflows has since dropped
    // changes nothing).
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ instanceId: resource, news, output, session }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const label = news.targets.join(", ");
      const started = yield* Clock.currentTimeMillis;
      const timeout = (news.timeoutSeconds ?? 1800) * 1000;
      const instance = (id: string) =>
        workflows
          .getInstance({ accountId, workflowName: news.workflowName, instanceId: id })
          .pipe(Effect.retry(retryInternal));

      // The instance a deploy that stopped waiting left behind: stop it, so it doesn't keep
      // checking runs no one waits on. Best effort: it ends by itself once they complete.
      if (output?.instanceId !== undefined && output.status !== "complete")
        yield* workflows
          .patchInstanceStatus({
            accountId,
            workflowName: news.workflowName,
            instanceId: output.instanceId,
            status: "terminate",
          })
          .pipe(
            Effect.asVoid,
            Effect.catchTag(
              ["InstanceNotFound", "WorkflowNotFound", "InstanceCannotTerminate"],
              () => Effect.void,
            ),
          );

      /**
       * Start an instance for this wait. Each deploy (and each start again) gets a new one:
       * it only starts the runs and reports on them, and starting a run that is already
       * started finds it, so a new instance never starts a backfill over.
       */
      const start = (attempt: number) =>
        Effect.gen(function* () {
          const id = instanceIdOf(news.targets, resource, `${started.toString(36)}${attempt}`);
          yield* workflows
            .createInstance({
              accountId,
              workflowName: news.workflowName,
              instanceId: id,
              params: { targets: news.targets, plans: news.plans ?? {} },
            })
            .pipe(
              Effect.asVoid,
              Effect.catchTag("InstanceAlreadyExists", () => Effect.void),
              // The Workflow is uploaded with the Worker: it can take a moment to appear.
              Effect.retry({
                while: (error) =>
                  error._tag === "WorkflowNotFound" || error._tag === "WorkflowInternalError",
                schedule: Schedule.spaced("2 seconds"),
                times: 30,
              }),
            );
          return id;
        });

      let attempt = 0;
      let id = yield* start(attempt);
      let progress: ReadonlyArray<Progress> | undefined;
      const attrs = () => ({ accountId, workflowName: news.workflowName, targets: news.targets });
      const where = () =>
        progress === undefined ? label : progress.map((run) => describeProgress(run)).join("; ");

      for (let poll = 0; ; poll++) {
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        const status = poll % PROGRESS_EVERY === 0 ? yield* instance(id) : undefined;
        const current =
          status ??
          (yield* workflows
            .getInstance({
              accountId,
              workflowName: news.workflowName,
              instanceId: id,
              simple: true,
            })
            .pipe(Effect.retry(retryInternal)));
        if (status !== undefined) progress = progressOf(status.steps ?? []) ?? progress;

        if (current.status === "complete") {
          yield* session.note(`Backfilled ${label}`, { kind: "status" });
          return { ...attrs(), instanceId: id, status: "complete" };
        }
        if (current.status === "errored" || current.status === "terminated") {
          const failed = status ?? (yield* instance(id));
          const message = failed.error?.message ?? "";
          // The runs are unaffected: a new instance waits on them, from where they are.
          if (
            (current.status === "terminated" || startedTooSoon(message)) &&
            attempt < MAX_RESTARTS
          ) {
            attempt += 1;
            yield* Effect.sleep(RESTART_DELAY);
            id = yield* start(attempt);
            continue;
          }
          // A consumer that reads other sources than its run: the reason is the whole message.
          const changed = /BackfillPlanChanged: (.*)$/s.exec(message)?.[1];
          const reason = message
            ? `: ${failed.error?.name ?? "Error"}: ${message.replace(/\.$/, "")}`
            : "";
          return yield* new BackfillFailed({
            message:
              changed ??
              `The backfill of ${label} ended ${current.status}${reason}.${progress === undefined ? "" : ` Where it got to: ${where()}.`}`,
            instanceId: id,
            status: current.status,
          });
        }
        if (elapsed > timeout) {
          return yield* new BackfillStillRunning({
            message: `The backfill of ${label} is still running after ${Math.round(elapsed / 1000)}s: ${where()}. It keeps running on Cloudflare; the next deploy waits on it again.`,
            instanceId: id,
          });
        }
        yield* session.note(`Backfilling ${where()} (${Math.round(elapsed / 1000)}s) ...`, {
          kind: "status",
        });
        yield* Effect.sleep(POLL);
      }
    }),
    // The runs belong to the consumers' classes, which the Worker deletes with them: here,
    // only stop the instance a deploy may have left waiting.
    delete: Effect.fn(function* ({ output }) {
      yield* workflows
        .patchInstanceStatus({
          accountId: output.accountId,
          workflowName: output.workflowName,
          instanceId: output.instanceId,
          status: "terminate",
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTag(
            ["InstanceNotFound", "WorkflowNotFound", "InstanceCannotTerminate"],
            () => Effect.void,
          ),
        );
    }),
  });

/** In `alchemy dev` the Domain backfills itself on its first call: nothing to wait for. */
const BackfillLocal = () =>
  Provider.succeed(Backfill, {
    diff: Effect.fn(function* () {
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ instanceId, news }) {
      return {
        accountId: "dev",
        workflowName: news.workflowName,
        instanceId: `dev:${instanceIdOf(news.targets, instanceId, "local")}`,
        targets: news.targets,
        status: "complete",
      };
    }),
    delete: Effect.fn(function* () {}),
  });

export const BackfillProvider = () =>
  ProviderLayer.dual(Backfill, {
    local: () => BackfillLocal(),
    live: () => BackfillLive(),
  });
