interface WorkItemIdentity {
  readonly kind: "issue" | "pull-request";
  readonly provider: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
}

interface WorkItemSource extends WorkItemIdentity {
  readonly body: string;
}

interface GeneratedMatch {
  readonly candidate: number;
  readonly confidence: "high" | "medium";
  readonly reason: string;
}

const words = (text: string) =>
  new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? []);

export const workItemIdentityKey = (
  item: Pick<WorkItemIdentity, "kind" | "provider" | "repository" | "number">,
) =>
  `${item.kind}:${item.provider.toLocaleLowerCase()}:${item.repository.toLocaleLowerCase()}#${item.number}`;

const sameWorkItem = (left: WorkItemIdentity, right: WorkItemIdentity) =>
  workItemIdentityKey(left) === workItemIdentityKey(right);

export function shortlistWorkItemCandidates<T extends WorkItemIdentity>(
  source: WorkItemSource,
  candidates: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const sourceWords = words(`${source.title} ${source.body}`);
  return candidates
    .filter((candidate) => !sameWorkItem(source, candidate))
    .map((candidate) => ({
      candidate,
      score: [...words(candidate.title)].filter((word) => sourceWords.has(word)).length,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 12)
    .map(({ candidate }) => candidate);
}

export function resolveWorkItemMatches(
  candidates: ReadonlyArray<WorkItemIdentity>,
  generated: ReadonlyArray<GeneratedMatch>,
) {
  const seen = new Set<number>();
  return generated
    .flatMap((match) => {
      // Prompt numbers candidates from one; zero, negatives, and past-end values are invalid.
      const index = match.candidate - 1;
      const candidate = candidates[index];
      const reason = match.reason.trim().slice(0, 300);
      if (!candidate || seen.has(index) || reason.length === 0) return [];
      seen.add(index);
      return [
        {
          kind: candidate.kind,
          provider: candidate.provider,
          repository: candidate.repository,
          number: candidate.number,
          title: candidate.title,
          url: candidate.url,
          confidence: match.confidence,
          reason,
        },
      ];
    })
    .slice(0, 5);
}
