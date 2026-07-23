import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { Stdio } from "effect/Stdio";
import type { Terminal } from "effect/Terminal";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { BaseRuntimeContext } from "../RuntimeContext.ts";

export type ProcessServices =
  | ChildProcessSpawner
  | FileSystem
  | Path
  | Stdio
  | Terminal;

export interface ProcessContext extends BaseRuntimeContext {
  run: <Req = never, RunReq = never>(
    effect: Effect.Effect<void, never, RunReq>,
  ) => Effect.Effect<void, never, Req | RunReq>;
}

/**
 * Long-running host loop registration (`run`). Provided by `Platform` when the
 * execution context implements {@link ProcessContext}.
 */
export class ServerHost extends Context.Service<
  ServerHost,
  Pick<ProcessContext, "run">
>()("Alchemy::ServerHost") {}
