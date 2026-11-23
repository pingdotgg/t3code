// What the server hands a workflow file as globals, for the fixtures here to be type-checked.
import type * as api from "../../../apps/server/src/workflows/api.ts";

declare global {
  const T3: Omit<typeof api, "Duration" | "Effect" | "Option" | "Schedule" | "Schema">;
  const Duration: typeof api.Duration;
  const Effect: typeof api.Effect;
  const Option: typeof api.Option;
  const Schedule: typeof api.Schedule;
  const Schema: typeof api.Schema;
}
