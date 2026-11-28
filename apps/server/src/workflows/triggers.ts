// What starts a run by itself. A trigger hands its workflow one value, so a workflow that lists
// a trigger takes that value as its payload: `Tick` for a schedule, `WebhookRequest` for a hook.
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

import { parseTimeOfDay } from "../scheduledTasks/Schedule.ts";
import { checkOptions, durationOf } from "./options.ts";
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
  /** The same for every spelling of one schedule, and across restarts. */
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
  const label = `every(${typeof interval === "bigint" ? `${interval}n` : JSON.stringify(interval)})`;
  const everyMs = Duration.toMillis(durationOf(label, interval));
  // The sweep would quietly stretch a shorter one to a minute.
  if (everyMs < 60_000) {
    throw new Error(`${label} is shorter than the shortest, one minute.`);
  }
  return { kind: "schedule", id: `every:${everyMs}`, schedule: { type: "interval", everyMs } };
};

const dailyId = (time: { hour: number; minute: number }, weekdays: ReadonlyArray<number>) => {
  const pad = (part: number) => String(part).padStart(2, "0");
  // None and all seven are both every day, as the schedule reads them.
  const days = weekdays.length === 0 || weekdays.length === 7 ? "all" : weekdays.join(",");
  return `daily:${pad(time.hour)}:${pad(time.minute)}:${days}`;
};

const WEEKDAY = /^[0-6]$/;

/**
 * The id `daily` gives now for one it gave when ids followed the spelling (`daily:9:00:all`,
 * `daily:09:00:3,1,1`), which saved next times and run keys may still carry. Any other id is
 * returned as it is.
 */
export const currentScheduleId = (id: string): string => {
  const written = /^daily:(.*):([^:]*)$/s.exec(id);
  const time = written === null ? null : parseTimeOfDay(written[1]!);
  if (written === null || time === null) return id;
  const days = written[2] === "all" || written[2] === "" ? [] : written[2]!.split(",");
  if (!days.every((day) => WEEKDAY.test(day))) return id;
  return dailyId(time, [...new Set(days.map(Number))].toSorted());
};

/**
 * A run at a time of day (`"09:00"`) on the server's clock, on every day or on the given weekdays
 * (0 is Sunday). A time missed by more than ten minutes, for a server that was down, is skipped.
 */
export const daily = (
  timeOfDay: string,
  options?: { readonly weekdays?: ReadonlyArray<number> },
): Trigger<Tick> => {
  checkOptions(`daily("${timeOfDay}")`, options, ["weekdays"]);
  const weekdays = options?.weekdays;
  // Read once here: a time the schedule cannot read would otherwise never fire, without a word.
  const time = parseTimeOfDay(timeOfDay);
  if (time === null) {
    throw new Error(`daily("${timeOfDay}") needs a 24-hour time such as "09:00".`);
  }
  const days = [...new Set(weekdays)].toSorted();
  if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error(
      `daily's weekdays are 0 (Sunday) to 6 (Saturday), not ${weekdays?.join(", ")}.`,
    );
  }
  return {
    kind: "schedule",
    // From what the schedule reads, not how it was written: `"9:00"` and `"09:00"` are one time.
    id: dailyId(time, days),
    schedule: { type: "fixed_time", timeOfDay, ...(weekdays === undefined ? {} : { weekdays }) },
  };
};

/**
 * A run for each request to this workflow's hook URL (`hyakki workflow hooks` prints it). The run
 * decides what the request means, `stop` included. Two requests for which `key` gives the same
 * text are one run, which is how a sender's retries are told from new deliveries.
 */
export const webhook = (
  name: string,
  options?: { readonly key?: (request: WebhookRequest) => string | undefined },
): Trigger<WebhookRequest> => {
  checkOptions(`webhook("${name}")`, options, ["key"]);
  return { kind: "webhook", name, key: options?.key };
};

/** Refuses two hooks of one name, or two triggers that would fire on the same thing. */
export const checkTriggers = (
  workflow: string,
  triggers: ReadonlyArray<ScheduleTrigger | WebhookTrigger | OpenedTrigger>,
) => {
  const seen = new Set<string>();
  for (const trigger of triggers) {
    const id = trigger.kind === "webhook" ? `webhook:${trigger.name}` : trigger.id;
    if (seen.has(id)) {
      throw new Error(
        trigger.kind === "webhook"
          ? `workflow("${workflow}") has two hooks named "${trigger.name}". Give each its own name.`
          : `workflow("${workflow}") lists the same ${trigger.kind === "schedule" ? "schedule" : "trigger"} twice. List it once.`,
      );
    }
    seen.add(id);
  }
};

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
}): Trigger<Issue> => {
  checkOptions("issues.opened", options, ["project", "labels", "query"]);
  return { kind: "issues", id: openedId("issues", options), ...options };
};

/**
 * A run for each pull request opened against the project's repository from now on, with the pull
 * request as its payload (`PullRequest`). `query` is free text for the host.
 */
export const pullRequestsOpened = (options: {
  readonly project: string;
  readonly query?: string;
}): Trigger<PullRequest> => {
  checkOptions("pullRequests.opened", options, ["project", "query"]);
  return { kind: "pullRequests", id: openedId("pullRequests", options), ...options };
};
