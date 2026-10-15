/**
 * IssueTrackerHost — what a standalone tracker package may ask of the server it runs in.
 *
 * A standalone tracker signs its requests with a credential the user saved in Settings, which the
 * server keeps in its secret store. The package must not import the server, so it reads the
 * credential through this one service; the server provides it. Git-host trackers never need it:
 * their CLIs and the source control host carry their own credentials.
 *
 * @module issue-tracker-core/server/IssueTrackerHost
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
>()("@t3tools/issue-tracker-core/server/IssueTrackerHost") {}
