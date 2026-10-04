import type { ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { useServerConfigs } from "../../state/entities";
import { taskLinks } from "../../state/tasks";
import { useEnvironmentQuery } from "../../state/query";

/** Show persisted source-task references for an environment-scoped thread without exposing credentials. */
export function TaskSourceLinks({
  projectRef,
  threadId,
}: {
  projectRef: ScopedProjectRef;
  threadId: ThreadId;
}) {
  const supported = useServerConfigs().get(projectRef.environmentId)?.environment.capabilities
    .externalTasks;
  const result = useEnvironmentQuery(
    supported
      ? taskLinks({
          environmentId: projectRef.environmentId,
          input: { projectId: projectRef.projectId, action: "links", threadId },
        })
      : null,
  );
  if (!result.data?.links.length) return null;
  return (
    <div className="flex flex-wrap gap-3 px-3 py-1 text-xs" aria-label="Linked tasks">
      {result.data.links.map((link) => (
        <a
          key={link.taskUrl}
          href={link.taskUrl}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          {link.taskKey} · {link.title}
        </a>
      ))}
    </div>
  );
}
