import { Function } from "@/Neon/Function";
import * as Effect from "effect/Effect";
import { ConnectProject } from "./connect-database.ts";
import { connectHandler } from "./connect-handler.ts";

export default class ConnectProjectFunction extends Function<ConnectProjectFunction>()(
  "ConnectProjectFunction",
  Effect.gen(function* () {
    const project = yield* ConnectProject;
    return { project: { projectId: project.projectId }, main: import.meta.url };
  }),
  connectHandler,
) {}
