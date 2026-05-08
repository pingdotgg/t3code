import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { EnvironmentId } from "@forma/contracts";

import { invalidateProjectEntryQueries, projectQueryKeys } from "./projectReactQuery";

describe("invalidateProjectEntryQueries", () => {
  it("invalidates only affected directory entry keys and the search scope", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const environmentId = EnvironmentId.make("environment-local");

    await invalidateProjectEntryQueries(queryClient, {
      environmentId,
      cwd: "/repo/project",
      relativePaths: ["src/a.ts", "lib", null],
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.listEntries(environmentId, "/repo/project", "src"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.listEntries(environmentId, "/repo/project", "src/a.ts"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.listEntries(environmentId, "/repo/project", "lib"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.listEntries(environmentId, "/repo/project", null),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.searchEntriesScope(environmentId, "/repo/project"),
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: projectQueryKeys.localAgentInventoryScope(environmentId, "/repo/project"),
    });
  });
});
