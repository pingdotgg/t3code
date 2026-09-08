import type {
  ExecCommandError,
  ExecResult,
} from "@distilled.cloud/fly-io/sprites";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Sprite } from "./Sprite.ts";

export interface ExecRequest {
  /** Command and args. */
  cmd: string[];
  /** Explicit path to the executable. */
  path?: string;
  /** Read stdin from {@link body}. */
  stdin?: boolean;
  /** Environment variables as `KEY=VALUE`. */
  env?: string[];
  /** Working directory. */
  dir?: string;
  /** Stdin bytes when {@link stdin} is true. */
  body?: Uint8Array | string;
}

/**
 * Run a command on a {@link Sprite} via `POST /sprites/{name}/exec`.
 *
 *
 * ### Exec a command
 * Bind the client in init. Provide {@link ExecHttp}. The Sprite name
 * is fixed by `Exec(box)`.
 *
 * **Example:** List files
 * ```typescript
 * const exec = yield* Fly.Exec(Box);
 * const result = yield* exec({ cmd: ["ls", "-la"] });
 * ```
 *
 * @binding
 */
export interface Exec extends Binding.Service<
  Exec,
  "Fly.Exec",
  (
    sprite: Sprite,
  ) => Effect.Effect<
    (
      request: ExecRequest,
    ) => Effect.Effect<ExecResult, ExecCommandError, RuntimeContext>
  >
> {}

export const Exec = Binding.Service<Exec>("Fly.Exec");
