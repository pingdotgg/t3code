import type { OrchestrationV2ThreadDetailSnapshot, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";

export type ThreadSnapshotHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly latestLocalTurnOrdinal?: number | null;
};

export type ThreadSnapshotLoadResult =
  | {
      readonly _tag: "present";
      readonly snapshot: OrchestrationV2ThreadDetailSnapshot;
      readonly history?: ThreadSnapshotHistoryMeta;
    }
  | { readonly _tag: "missing" }
  | { readonly _tag: "unavailable" };

export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) => Effect.Effect<ThreadSnapshotLoadResult>;
  }
>()("@t3tools/client-runtime/state/threadSnapshotHttp/ThreadSnapshotLoader") {}
