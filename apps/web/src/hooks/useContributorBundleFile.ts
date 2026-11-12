import {
  CONTRIBUTOR_BUNDLE_FILE_NAME,
  type ContributorBundle,
  type EnvironmentId,
} from "@t3tools/contracts";
import { parseContributorBundle } from "@t3tools/shared/contributorBundle";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

export interface ContributorBundleFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  bundle: ContributorBundle | null;
}

export function useContributorBundleFile(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): ContributorBundleFileState {
  const query = useProjectFileQuery(
    environmentId ?? ("" as EnvironmentId),
    cwd ?? "",
    CONTRIBUTOR_BUNDLE_FILE_NAME,
    environmentId !== null && cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      bundle: null,
    } as const;
  }
  const bundle = parseContributorBundle(contents);
  if (bundle === null) {
    return { status: "invalid", bundle: null } as const;
  }
  return { status: "valid", bundle } as const;
}
