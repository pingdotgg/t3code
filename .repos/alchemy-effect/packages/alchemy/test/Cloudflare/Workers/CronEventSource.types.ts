import * as Cloudflare from "@/Cloudflare";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

class ScheduledTask extends Context.Service<
  ScheduledTask,
  { run: Effect.Effect<void, never, RuntimeContext> }
>()("test/ScheduledTask") {}

const ScheduleExpression = "* * * * *";

const runScheduledTask = Effect.fn("ScheduledWorker.runTask")(function* () {
  const task = yield* ScheduledTask;
  yield* task.run;
});

export const ScheduledTaskCronBinding = Cloudflare.Workers.cron(
  ScheduleExpression,
  Effect.fn("ScheduledWorker.cron")(function* () {
    yield* runScheduledTask();
  }),
);

type RequirementsOf<T> =
  T extends Effect.Effect<unknown, unknown, infer Req> ? Req : never;
type Assert<T extends true> = T;

type _PreservesUserRequirement = Assert<
  ScheduledTask extends RequirementsOf<typeof ScheduledTaskCronBinding>
    ? true
    : false
>;
type _StillRequiresCronEventSource = Assert<
  Cloudflare.Workers.CronEventSource extends RequirementsOf<
    typeof ScheduledTaskCronBinding
  >
    ? true
    : false
>;
type _HidesRuntimeContext = Assert<
  RuntimeContext extends RequirementsOf<typeof ScheduledTaskCronBinding>
    ? false
    : true
>;
