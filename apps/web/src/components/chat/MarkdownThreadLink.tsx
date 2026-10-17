import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatThreadLink,
  percentDecodedThreadLinkId,
  resolveThreadLinkRef,
} from "@t3tools/shared/threadLinks";
import { Link } from "@tanstack/react-router";
import { MessageSquareTextIcon } from "lucide-react";

import { useProject, useThreadRefs, useThreadShell } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";

export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
}) {
  const decodedId = percentDecodedThreadLinkId(props.threadId);
  const written = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(props.environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  const refs = useThreadRefs(local === null);
  const remote = useThreadShell(
    local === null
      ? resolveThreadLinkRef(scopeThreadRef(props.environmentId, props.threadId), refs)
      : null,
  );
  const thread = local ?? remote;
  const environmentId = thread?.environmentId ?? props.environmentId;
  const threadId = thread?.id ?? props.threadId;
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  const title = thread?.title.trim() || props.label;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId }}
      title={thread === null ? "Thread no longer available" : project?.title}
      data-markdown-copy={formatThreadLink(threadId, title)}
    >
      <span
        className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
        aria-hidden
      >
        {project === null ? (
          <MessageSquareTextIcon className="block size-full shrink-0" />
        ) : (
          <ProjectFavicon project={project} className="size-full" />
        )}
      </span>
      {title}
    </Link>
  );
}
