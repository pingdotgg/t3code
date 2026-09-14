import type { OrchestrationCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";

/** Supplied only by drive serve for a newly claimed, isolated scenario home. */
export class DriveMode extends Context.Reference<ReadonlyArray<OrchestrationCommand> | undefined>(
  "t3/driveMode",
  { defaultValue: () => undefined },
) {}
