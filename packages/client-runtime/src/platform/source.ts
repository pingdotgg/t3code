import * as Context from "effect/Context";
import type * as Stream from "effect/Stream";

import type { PlatformConnectionRegistration } from "../connection/catalog.ts";

export class PlatformConnectionSource extends Context.Service<
  PlatformConnectionSource,
  {
    readonly snapshots: Stream.Stream<{
      readonly registrations: ReadonlyArray<PlatformConnectionRegistration>;
      /** Every target named by the current platform topology has been resolved. */
      readonly discoveryComplete: boolean;
    }>;
  }
>()("@t3tools/client-runtime/platform/source/PlatformConnectionSource") {}
