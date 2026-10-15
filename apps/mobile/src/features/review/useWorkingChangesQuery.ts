import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";

export function useWorkingChangesQuery(input: {
  environmentId: EnvironmentId;
  cwd: string;
  scope: "staged" | "unstaged" | undefined;
  revision: string | undefined;
  generation: number;
}) {
  const query = useEnvironmentQuery(
    reviewEnvironment.diffPreview({
      environmentId: input.environmentId,
      input: { cwd: input.cwd, ...(input.scope ? { workingTreeScope: input.scope } : {}) },
    }),
  );
  const { refresh } = query;
  // The parent reads the same combined query. Its response timestamp can invalidate
  // the scoped previews, but refreshing the combined query here would feed itself.
  const revision = input.scope ? input.revision : undefined;
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- Revision and mutation generation invalidate the same cached query.
  }, [refresh, revision, input.generation]);
  return query;
}
