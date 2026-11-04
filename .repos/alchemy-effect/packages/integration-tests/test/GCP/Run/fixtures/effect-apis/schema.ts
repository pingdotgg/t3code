import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Rpc, RpcGroup } from "effect/rpc";
import * as Schema from "effect/Schema";

export class Task extends Schema.Class<Task>("Task")({
  id: Schema.String,
  title: Schema.String,
}) {}

export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()(
  "TaskNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

export class TaskRpcs extends RpcGroup.make(
  Rpc.make("getTask", { payload: { id: Schema.String }, success: Task, error: TaskNotFound }),
  Rpc.make("countTasks", { payload: { to: Schema.Number }, success: Schema.Number, stream: true }),
) {}

export class TasksGroup extends HttpApiGroup.make("Tasks").add(
  HttpApiEndpoint.get("getTask", "/tasks/:id", {
    params: Schema.Struct({ id: Schema.String }),
    success: Task,
    error: TaskNotFound,
  }),
) {}

export class TaskApi extends HttpApi.make("TaskApi").add(TasksGroup) {}

/** The one task every server knows. */
export const lookup = (id: string, from: string) =>
  id === "t1" ? new Task({ id, title: `from ${from}` }) : undefined;
