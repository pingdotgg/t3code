import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessageSquareTextIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useProject, useThreadShell } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";

/**
 * A `t3-thread://` link in chat. It leads with the thread's project icon, like
 * a web link leads with its favicon, so it reads as a thread link before you
 * hover it. Opens the thread in the app.
 */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly children: ReactNode;
}) {
  const thread = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const project = useProject(
    thread === null ? null : scopeProjectRef(props.environmentId, thread.projectId),
  );
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: props.environmentId, threadId: props.threadId }}
      title={project?.title}
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
      {props.children}
    </Link>
  );
}
