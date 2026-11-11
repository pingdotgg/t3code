import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatHostedThreadLink,
  guessThreadLinkRef,
  threadLinkCandidates,
  type ThreadLink,
  unknownThreadLinkLabel,
} from "@t3tools/shared/threadLinks";

import { configuredHostedAppUrl } from "../../hostedPairing";
import { useThreadRefs, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";

/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: ThreadLink;
  readonly label: string | null;
}) {
  const candidates = threadLinkCandidates(props.link, props.environmentId);
  const writtenRef = candidates[0]!;
  const written = useThreadShell(writtenRef);
  const lookup = useEnvironmentQuery(
    written === null
      ? orchestrationEnvironment.threadLinkMetadata({
          environmentId: writtenRef.environmentId,
          input: { threadIds: candidates.map((ref) => ref.threadId) },
        })
      : null,
  );
  const settled = lookup.isSuccess && !lookup.isPending;
  const target =
    written !== null
      ? { ref: writtenRef, metadata: written }
      : (candidates.flatMap((ref) => {
          const metadata = lookup.data?.[ref.threadId];
          return metadata ? [{ ref, metadata }] : [];
        })[0] ?? null);
  const missing = target === null && settled;
  const guess = missing && props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const remoteRef = guess
    ? guessThreadLinkRef(
        props.link,
        refs.filter((ref) => ref.environmentId !== writtenRef.environmentId),
      )
    : null;
  const remote = useThreadShell(remoteRef);
  const resolved = target ?? (remoteRef && remote ? { ref: remoteRef, metadata: remote } : null);
  if (missing && resolved === null) {
    const unknown = unknownThreadLinkLabel(props.link, props.environmentId);
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = resolved?.ref ?? writtenRef;
  const title = resolved?.metadata.title.trim() || props.label || "Thread";
  return (
    <ThreadContextChip
      record={{ ...ref, title }}
      projectId={resolved?.metadata.projectId ?? null}
      copyMarkdown={formatHostedThreadLink(ref, title, configuredHostedAppUrl())}
    />
  );
}
