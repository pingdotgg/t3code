// What starts a run by itself. A trigger hands its workflow one value, so a workflow that lists
// a trigger takes that value as its payload: `Tick` for a schedule, `WebhookRequest` for a hook.
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

import { parseTimeOfDay } from "../scheduledTasks/Schedule.ts";
import type { Issue, PullRequest } from "./WorkflowForge.ts";

/** The time a scheduled run was due, which is not the time it started. */
export const Tick = Schema.Struct({ scheduledAt: Schema.String });
export type Tick = typeof Tick.Type;

/** A request to a workflow's hook URL, as it arrived. Header names are lower case. */
export const WebhookRequest = Schema.Struct({
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  query: Schema.String,
  body: Schema.String,
});
export type WebhookRequest = typeof WebhookRequest.Type;

export interface ScheduleTrigger {
  readonly kind: "schedule";
  /** Stable across restarts: where this trigger's next time is kept. */
  readonly id: string;
  readonly schedule:
    | { readonly type: "interval"; readonly everyMs: number }
    | {
        readonly type: "fixed_time";
        readonly timeOfDay: string;
        readonly weekdays?: ReadonlyArray<number>;
      };
}
export interface WebhookTrigger {
  readonly kind: "webhook";
  readonly name: string;
  readonly key: ((request: WebhookRequest) => string | undefined) | undefined;
}
/** New issues or pull requests of a project, which the engine looks for by itself. */
export interface OpenedTrigger {
  readonly kind: "issues" | "pullRequests";
  /** Stable across restarts: where this trigger keeps how far it has looked. */
  readonly id: string;
  readonly project: string;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly query?: string | undefined;
}
/** `Fires` is what the trigger gives the run it starts. */
export type Trigger<Fires> = (ScheduleTrigger | WebhookTrigger | OpenedTrigger) & {
  readonly fires?: (value: Fires) => void;
};

/** A run every so often, counted from when the last one was started. At least a minute. */
export const every = (interval: Duration.Input): Trigger<Tick> => {
  const everyMs = Duration.toMillis(Duration.fromInputUnsafe(interval));
  return { kind: "schedule", id: `every:${everyMs}`, schedule: { type: "interval", everyMs } };
};

/**
 * A run at a time of day (`"09:00"`) on the server's clock, on every day or on the given weekdays
 * (0 is Sunday). A time missed by more than ten minutes, for a server that was down, is skipped.
 */
export const daily = (
  timeOfDay: string,
  options?: { readonly weekdays?: ReadonlyArray<number> },
): Trigger<Tick> => {
  const weekdays = options?.weekdays;
  // Read once here: a time the schedule cannot read would otherwise never fire, without a word.
  if (parseTimeOfDay(timeOfDay) === null) {
    throw new Error(`daily("${timeOfDay}") needs a 24-hour time such as "09:00".`);
  }
  if (weekdays?.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error(`daily's weekdays are 0 (Sunday) to 6 (Saturday), not ${weekdays.join(", ")}.`);
  }
  return {
    kind: "schedule",
    id: `daily:${timeOfDay}:${weekdays?.toSorted().join(",") ?? "all"}`,
    schedule: { type: "fixed_time", timeOfDay, ...(weekdays === undefined ? {} : { weekdays }) },
  };
};

/**
 * A run for each request to this workflow's hook URL (`t3 workflow hooks` prints it). The run
 * decides what the request means, `stop` included. Two requests for which `key` gives the same
 * text are one run, which is how a sender's retries are told from new deliveries.
 */
export const webhook = (
  name: string,
  options?: { readonly key?: (request: WebhookRequest) => string | undefined },
): Trigger<WebhookRequest> => ({ kind: "webhook", name, key: options?.key });

const openedId = (
  kind: OpenedTrigger["kind"],
  options: {
    readonly project: string;
    readonly labels?: ReadonlyArray<string>;
    readonly query?: string;
  },
) =>
  // A tuple, so no label or query can be read as part of another.
  JSON.stringify([kind, options.project, options.labels?.toSorted() ?? [], options.query ?? ""]);

/**
 * A run for each issue opened in the project's tracker from now on, with the issue as its
 * payload (`Issue`). Issues that were already there when the workflow was first loaded start
 * nothing. `labels` are ones the issue must carry, all of them; `query` is free text for the
 * tracker. The tracker is asked about once a minute.
 */
export const issuesOpened = (options: {
  readonly project: string;
  readonly labels?: ReadonlyArray<string>;
  readonly query?: string;
}): Trigger<Issue> => ({ kind: "issues", id: openedId("issues", options), ...options });

/**
 * A run for each pull request opened against the project's repository from now on, with the pull
 * request as its payload (`PullRequest`). `query` is free text for the host.
 */
export const pullRequestsOpened = (options: {
  readonly project: string;
  readonly query?: string;
}): Trigger<PullRequest> => ({
  kind: "pullRequests",
  id: openedId("pullRequests", options),
  ...options,
});
