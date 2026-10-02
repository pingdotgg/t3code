import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { makeKeyedSerialExecutor, type KeyedSerialExecutor } from "./KeyedSerialExecutor.ts";

/** Shared by thread commands and project deletion so both plan against current thread state. */
export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedSerialExecutor<ThreadId>
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(ThreadCommandExecutor, makeKeyedSerialExecutor<ThreadId>());
