import { queryOptions, skipToken } from "@tanstack/react-query";
import { readNativeApi } from "../session-logic";

export const listBranchesQuery = (cwd: string | undefined) => {
  const api = readNativeApi();

  return queryOptions({
    queryKey: ["git-branches", cwd],
    queryFn: api && cwd ? () => api.git.listBranches({ cwd }) : skipToken,
    refetchOnWindowFocus: true,
  });
};
