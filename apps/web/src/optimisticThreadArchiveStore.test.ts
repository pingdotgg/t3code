import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  optimisticallyHideArchivedThread,
  revealOptimisticallyArchivedThread,
  useOptimisticThreadArchiveStore,
} from "./optimisticThreadArchiveStore";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("optimisticThreadArchiveStore", () => {
  beforeEach(() => {
    useOptimisticThreadArchiveStore.setState({
      threadKeys: new Set(),
      operationCounts: new Map(),
    });
  });

  it("keeps a thread hidden until every concurrent archive operation completes", () => {
    optimisticallyHideArchivedThread(threadRef);
    optimisticallyHideArchivedThread(threadRef);

    revealOptimisticallyArchivedThread(threadRef);
    expect(useOptimisticThreadArchiveStore.getState().threadKeys.size).toBe(1);

    revealOptimisticallyArchivedThread(threadRef);
    expect(useOptimisticThreadArchiveStore.getState().threadKeys.size).toBe(0);
  });
});
