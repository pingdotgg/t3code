import type { Daytona } from "@daytonaio/sdk";
import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

import type { EnsureSnapshotError } from "./snapshot.errors";

export type DaytonaSnapshot = Awaited<ReturnType<Daytona["snapshot"]["get"]>>;

export interface EnsureSnapshotOptions {
  readonly name?: string;
  readonly replace?: boolean;
  readonly activate?: boolean;
  readonly onLogs?: (chunk: string) => void;
  readonly timeoutSeconds?: number;
}

export interface SnapshotServiceShape {
  readonly ensureSnapshot: (
    options?: EnsureSnapshotOptions,
  ) => Effect.Effect<DaytonaSnapshot, EnsureSnapshotError>;
}

export class SnapshotService extends ServiceMap.Service<SnapshotService, SnapshotServiceShape>()(
  "@repo/sandbox/services/snapshot/SnapshotService",
) {}
