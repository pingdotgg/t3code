import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Linux PSI "some" averages: the share of time (0-100) some task waited on the resource. */
export const MachinePressure = Schema.Struct({
  avg10: Schema.Number,
  avg60: Schema.Number,
});
export type MachinePressure = typeof MachinePressure.Type;

/** A thread with a live agent on this server: working runs first, then idle open sessions. */
export const MachineAgent = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  state: Schema.Literals(["working", "open"]),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
});
export type MachineAgent = typeof MachineAgent.Type;

/** What one T3 server reports about the machine it runs on, for the machine bar. */
export const MachineStatus = Schema.Struct({
  hostname: TrimmedNonEmptyString,
  platform: TrimmedNonEmptyString,
  sampledAt: NonNegativeInt,
  cores: PositiveInt,
  /** 1, 5 and 15 minute load averages; null on Windows, which has none. */
  load: Schema.NullOr(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])),
  cpuUtilization: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  memory: Schema.Struct({ totalBytes: NonNegativeInt, availableBytes: NonNegativeInt }),
  swap: Schema.NullOr(Schema.Struct({ totalBytes: NonNegativeInt, usedBytes: NonNegativeInt })),
  disk: Schema.NullOr(Schema.Struct({ totalBytes: NonNegativeInt, freeBytes: NonNegativeInt })),
  /** Linux only; the other platforms report no pressure stall information. */
  pressure: Schema.NullOr(
    Schema.Struct({ cpu: MachinePressure, memory: MachinePressure, io: MachinePressure }),
  ),
  /** Threads with a run preparing, starting or running, delegated children included. */
  working: NonNegativeInt,
  /** Threads still bound to a live agent session but without such a run. */
  open: NonNegativeInt,
  /** The server's `machineStatus.maxWorkingAgents`; null leaves the room to memory alone. */
  maxWorkingAgents: Schema.NullOr(PositiveInt),
  agents: Schema.Array(MachineAgent),
});
export type MachineStatus = typeof MachineStatus.Type;
