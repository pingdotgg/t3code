import * as Context from "effect/Context";
import type * as Stream from "effect/Stream";

import type { PlatformConnectionRegistration } from "../connection/catalog.ts";

export class PlatformConnectionSource extends Context.Service<
  PlatformConnectionSource,
  {
    // Each emission is the full current set of platform-managed environments
    // (the primary local environment plus any desktop-local backends running
    // alongside it). The registry reconciles the set, so the source can drive
    // both additions and removals by re-emitting.
    readonly registrations: Stream.Stream<ReadonlyArray<PlatformConnectionRegistration>>;
  }
>()("@t3tools/client-runtime/platform/source/PlatformConnectionSource") {}
