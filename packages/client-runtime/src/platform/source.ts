import * as Context from "effect/Context";
import type * as Stream from "effect/Stream";

import type { PrimaryConnectionRegistration } from "../connection/catalog.ts";

export class PlatformConnectionSource extends Context.Service<
  PlatformConnectionSource,
  {
    readonly registrations: Stream.Stream<PrimaryConnectionRegistration>;
  }
>()("@t3tools/client-runtime/platform/source/PlatformConnectionSource") {}
