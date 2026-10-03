/**
 * ServerShutdownMarkerRepository - Durable record of whether the previous
 * server process exited cleanly.
 *
 * Boot calls `beginSession`, which reports whether the *previous* process shut
 * down cleanly and then clears the marker. The graceful shutdown finalizer calls
 * `recordCleanShutdown` to set it again. A marker left unset therefore means the
 * last process died, which is how crash recovery distinguishes itself from a
 * planned restart.
 *
 * @module ServerShutdownMarker
 */
import { IsoDateTime } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface ServerShutdownMarkerRepositoryShape {
  /**
   * Read the previous process's clean-shutdown marker and clear it, so a second
   * boot in the same process sees an unclean exit rather than replaying the first
   * boot's verdict.
   *
   * True when the previous process recorded a clean shutdown before exiting.
   * False on the very first boot and after any unclean exit.
   */
  readonly beginSession: () => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Record that this process is shutting down cleanly.
   */
  readonly recordCleanShutdown: (
    cleanShutdownAt: IsoDateTime,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ServerShutdownMarkerRepository extends Context.Service<
  ServerShutdownMarkerRepository,
  ServerShutdownMarkerRepositoryShape
>()("t3/persistence/Services/ServerShutdownMarker/ServerShutdownMarkerRepository") {}
