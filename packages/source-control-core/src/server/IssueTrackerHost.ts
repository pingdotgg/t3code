/**
 * What a standalone tracker package may ask of the server it runs in: the credential the user
 * saved in Settings. Git-host trackers never need it; their CLIs carry their own credentials.
 */
import type { IssueTrackerKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { IssueTrackerError } from "./IssueTracker.ts";

export class IssueTrackerHost extends Context.Service<
  IssueTrackerHost,
  {
    readonly credentials: {
      /** Read fresh on each call, so a credential saved in Settings applies without a restart. */
      readonly get: (
        tracker: IssueTrackerKind,
      ) => Effect.Effect<Option.Option<string>, IssueTrackerError>;
    };
  }
>()("@t3tools/source-control-core/server/IssueTrackerHost") {}
