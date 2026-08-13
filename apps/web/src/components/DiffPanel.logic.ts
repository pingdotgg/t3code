import type { EnvironmentId, VcsListRefsInput, VcsStatusInput } from "@t3tools/contracts";

interface EnvironmentVcsTarget<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

export function resolveDiffVcsDemand(input: {
  readonly active: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly statusCwd: string | null;
  readonly branchRefsCwd: string | null;
  readonly branchScopeActive: boolean;
  readonly query: string;
}): {
  readonly status: EnvironmentVcsTarget<VcsStatusInput> | null;
  readonly localRefs: EnvironmentVcsTarget<VcsListRefsInput> | null;
  readonly remoteRefs: EnvironmentVcsTarget<VcsListRefsInput> | null;
} {
  if (!input.active || input.environmentId === null) {
    return { status: null, localRefs: null, remoteRefs: null };
  }

  const status =
    input.statusCwd === null
      ? null
      : { environmentId: input.environmentId, input: { cwd: input.statusCwd } };
  if (!input.branchScopeActive || input.branchRefsCwd === null) {
    return { status, localRefs: null, remoteRefs: null };
  }

  const query = input.query.trim();
  const refsInput = {
    cwd: input.branchRefsCwd,
    includeMatchingRemoteRefs: true,
    ...(query.length === 0 ? {} : { query }),
    limit: 100,
  };
  return {
    status,
    localRefs: {
      environmentId: input.environmentId,
      input: { ...refsInput, refKind: "local" },
    },
    remoteRefs: {
      environmentId: input.environmentId,
      input: { ...refsInput, refKind: "remote" },
    },
  };
}
