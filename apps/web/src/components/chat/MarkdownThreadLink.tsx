import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import {
  formatThreadLink,
  guessThreadLinkRef,
  percentDecodedThreadLinkId,
  type ThreadLink,
  unknownThreadLinkLabel,
} from "@t3tools/shared/threadLinks";

import { useThreadRefs, useThreadShell } from "../../state/entities";
import { useThreadFamilyIfMissing } from "../../state/threads";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";

/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: ThreadLink;
  readonly label: string | null;
}) {
  const environmentId = props.link.environmentId ?? props.environmentId;
  const sourceKey = JSON.stringify([environmentId, props.link.threadId]);
  const decodedId = percentDecodedThreadLinkId(props.link.threadId);
  const writtenRef = scopeThreadRef(environmentId, props.link.threadId);
  const written = useThreadShell(writtenRef);
  const writtenFamily = useThreadFamilyIfMissing(writtenRef, written === null);
  const writtenMissing = written === null && writtenFamily === "missing";
  const [decodedLookupKey, setDecodedLookupKey] = useState<string | null>(null);
  const decodedActive = decodedId !== null && (writtenMissing || decodedLookupKey === sourceKey);
  if (decodedLookupKey !== sourceKey && (decodedLookupKey !== null || decodedActive)) {
    setDecodedLookupKey(decodedActive ? sourceKey : null);
  }
  const decodedRef =
    decodedActive && decodedId !== null ? scopeThreadRef(environmentId, decodedId) : null;
  const decoded = useThreadShell(decodedRef);
  const decodedFamily = useThreadFamilyIfMissing(
    decodedRef,
    decodedRef !== null && decoded === null,
  );
  const local = written ?? decoded;
  const writtenFinished = writtenMissing || writtenFamily === "failed";
  const decodedFinished =
    decodedRef === null || decodedFamily === "failed" || decodedFamily === "missing";
  const guess =
    local === null && writtenFinished && decodedFinished && props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const guessedRef = guess
    ? guessThreadLinkRef(
        props.link,
        refs.filter((ref) => ref.environmentId !== environmentId),
      )
    : null;
  const [remoteSelection, setRemoteSelection] = useState<{
    sourceKey: string;
    ref: ScopedThreadRef;
  } | null>(null);
  const rememberedRef = remoteSelection?.sourceKey === sourceKey ? remoteSelection.ref : null;
  const remoteRef = guess ? rememberedRef : null;
  const remote = useThreadShell(remoteRef);
  const remoteFamily = useThreadFamilyIfMissing(remoteRef, remoteRef !== null && remote === null);
  const remoteMissing = remoteRef !== null && remote === null && remoteFamily === "missing";
  const matchesGuess =
    guessedRef !== null &&
    rememberedRef?.environmentId === guessedRef.environmentId &&
    rememberedRef.threadId === guessedRef.threadId;
  const preferWrittenGuess =
    guessedRef?.threadId === props.link.threadId && rememberedRef?.threadId !== props.link.threadId;
  if (
    guessedRef !== null &&
    !matchesGuess &&
    (rememberedRef === null || remoteMissing || preferWrittenGuess)
  ) {
    setRemoteSelection({ sourceKey, ref: guessedRef });
  }
  const thread = local ?? (matchesGuess ? remote : null);
  if (thread === null) {
    const unknown = unknownThreadLinkLabel(props.link, props.environmentId);
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = { environmentId: thread.environmentId, threadId: thread.id };
  const title = thread.title.trim() || props.label || "Untitled thread";
  return (
    <ThreadContextChip record={{ ...ref, title }} copyMarkdown={formatThreadLink(ref, title)} />
  );
}
