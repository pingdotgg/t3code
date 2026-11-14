import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Stream from "effect/Stream";
import { lookup, TaskApi, TaskNotFound, TaskRpcs } from "./schema.ts";

export const rpcHandlers = (from: string) =>
  TaskRpcs.toLayer({
    getTask: ({ id }) => {
      const task = lookup(id, from);
      return task ? Effect.succeed(task) : Effect.fail(new TaskNotFound({ id }));
    },
    countTasks: ({ to }) => Stream.range(1, to),
  });

export const httpApiHandlers = (from: string) =>
  HttpApiBuilder.group(TaskApi, "Tasks", (handlers) =>
    handlers.handle("getTask", ({ params }) => {
      const task = lookup(params.id, from);
      return task ? Effect.succeed(task) : Effect.fail(new TaskNotFound({ id: params.id }));
    }),
  );
