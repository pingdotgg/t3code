import type { VcsRef } from "@t3tools/contracts";

export interface BaseRefChoice {
  readonly id: string;
  readonly label: string;
  readonly local: VcsRef | null;
  readonly remote: VcsRef | null;
}

function remoteBranchName(ref: VcsRef): string {
  if (ref.remoteName && ref.name.startsWith(`${ref.remoteName}/`)) {
    return ref.name.slice(ref.remoteName.length + 1);
  }
  return ref.name;
}

export function buildBaseRefChoices(
  localRefs: ReadonlyArray<VcsRef>,
  remoteRefs: ReadonlyArray<VcsRef>,
): ReadonlyArray<BaseRefChoice> {
  const unusedRemoteRefs = new Set(remoteRefs);
  const pairedChoices = localRefs.map((local) => {
    const matches = remoteRefs.filter(
      (remote) => unusedRemoteRefs.has(remote) && remoteBranchName(remote) === local.name,
    );
    const remote =
      matches.find((candidate) => candidate.remoteName === "origin") ?? matches[0] ?? null;
    if (remote) unusedRemoteRefs.delete(remote);
    return {
      id: `local:${local.name}`,
      label: local.name,
      local,
      remote,
    };
  });

  const remoteOnlyChoices = remoteRefs
    .filter((remote) => unusedRemoteRefs.has(remote))
    .map((remote) => ({
      id: `remote:${remote.name}`,
      label: remote.name,
      local: null,
      remote,
    }));

  return [...pairedChoices, ...remoteOnlyChoices];
}

export function filterBaseRefChoices(
  choices: ReadonlyArray<BaseRefChoice>,
  query: string,
): ReadonlyArray<BaseRefChoice> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) return choices;
  return choices.filter(
    (choice) =>
      choice.label.toLocaleLowerCase().includes(normalizedQuery) ||
      choice.local?.name.toLocaleLowerCase().includes(normalizedQuery) === true ||
      choice.remote?.name.toLocaleLowerCase().includes(normalizedQuery) === true,
  );
}
