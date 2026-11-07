import { useEffect } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatHostedThreadLink,
  guessThreadLinkRef,
  percentDecodedThreadLinkId,
  type ThreadLink,
  unknownThreadLinkLabel,
} from "@t3tools/shared/threadLinks";

import { configuredHostedAppUrl } from "../../hostedPairing";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadRefs, useThreadShell } from "../../state/entities";
import { threadFamilies } from "../../state/threads";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";

/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: ThreadLink;
  readonly label: string | null;
}) {
  const environmentId = props.link.environmentId ?? props.environmentId;
  const decodedId = percentDecodedThreadLinkId(props.link.threadId);
  const written = useThreadShell(scopeThreadRef(environmentId, props.link.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  // Shells leave out idle subagent children and older settled threads, so a cited thread the
  // shell lacks is read with its family until it lands; only a settled empty read proves it gone.
  const missingThreadId = local === null ? (decodedId ?? props.link.threadId) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the family read for a cited thread the shell omits while this link shows it
  useEffect(
    () =>
      missingThreadId === null
        ? undefined
        : threadFamilies.mount(appAtomRegistry, environmentId, missingThreadId),
    [environmentId, missingThreadId],
  );
  const guess = local === null && props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const remote = useThreadShell(guess ? guessThreadLinkRef(props.link, refs) : null);
  const thread = local ?? remote;
  if (thread === null) {
    const unknown = unknownThreadLinkLabel(props.link, props.environmentId);
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = { environmentId: thread.environmentId, threadId: thread.id };
  const title = thread.title.trim() || props.label || "Untitled thread";
  return (
    <ThreadContextChip
      record={{ ...ref, title }}
      copyMarkdown={formatHostedThreadLink(ref, title, configuredHostedAppUrl())}
    />
  );
}
