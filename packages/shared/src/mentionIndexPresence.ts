import type {
  ComposerContextRecord,
  KnownComposerContextRecord,
  MentionIndexProviderId,
} from "@t3tools/contracts";

export type MentionIndexPresenceRequest = {
  readonly query: string;
  readonly providers: ReadonlyArray<MentionIndexProviderId>;
};

const KNOWN_KINDS = new Set([
  "image",
  "file",
  "terminal",
  "element",
  "preview-annotation",
  "review-comment",
  "pull-request",
  "mention",
  "skill",
  "thread",
  "environment",
  "jira",
  "figma",
  "issue",
]);

function asKnown(record: ComposerContextRecord): KnownComposerContextRecord | null {
  return KNOWN_KINDS.has(record.kind) ? (record as KnownComposerContextRecord) : null;
}

/** Exact index fetch requests for pasted/imported context chips that name one concrete item. */
export function mentionIndexPresenceRequests(
  records: ReadonlyArray<ComposerContextRecord>,
): ReadonlyArray<MentionIndexPresenceRequest> {
  const seen = new Set<string>();
  const requests: MentionIndexPresenceRequest[] = [];

  const add = (query: string, providers: ReadonlyArray<MentionIndexProviderId>) => {
    const key = `${providers.join(",")}:${query}`;
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ query, providers });
  };

  for (const candidate of records) {
    const record = asKnown(candidate);
    if (record === null) continue;
    switch (record.kind) {
      case "jira":
        add(record.key, ["jira"]);
        break;
      case "figma":
        add(record.fileKey, ["figma"]);
        break;
      case "issue":
        add(record.url, ["issue"]);
        break;
      case "pull-request":
        add(record.url, ["pull-request"]);
        break;
      case "review-comment":
        if (record.pullRequest !== undefined) {
          add(record.pullRequest.url, ["pull-request"]);
        }
        break;
      default:
        break;
    }
  }

  return requests;
}
