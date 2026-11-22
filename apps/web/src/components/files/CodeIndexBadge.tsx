import { useAtomValue } from "@effect/atom-react";
import { projectCodeIndexBadge } from "@t3tools/client-runtime/projectCode";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";

import { Badge } from "~/components/ui/badge";
import { projectCode } from "~/state/projectCode";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

const VARIANT = { ok: "success", warn: "warning", muted: "secondary" } as const;

/**
 * Plain-text freshness of a checkout's code index. It shows nothing until the server answers
 * rather than guessing a state.
 */
export function CodeIndexBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** A draft has no server thread; the project's own checkout is read instead. */
  readonly threadId?: ThreadId | undefined;
}) {
  const m = useMessages();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canQuery = useAtomValue(projectCode.freshness.permissionAtom(props.environmentId));
  const supported =
    config?.environment.capabilities.projectCode === true &&
    config.environment.capabilities.projectCodeFreshness === true &&
    canQuery;
  const freshness = useEnvironmentQuery(
    supported
      ? projectCode.freshness({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            ...(props.threadId ? { threadId: props.threadId } : {}),
            query: { operation: "freshness" },
          },
        })
      : null,
    m,
  );
  if (!supported) return null;
  if (freshness.data === null && freshness.error === null) return null;
  const badge =
    freshness.data === null
      ? { label: m(msg("Unavailable")), tone: "muted" as const, detail: freshness.error ?? "" }
      : projectCodeIndexBadge(freshness.data.index, m);
  return (
    <Badge
      variant={VARIANT[badge.tone]}
      size="sm"
      title={badge.detail}
      aria-label={m(msg("Code index: {label}. {detail}"), {
        label: badge.label,
        detail: badge.detail,
      })}
    >
      {badge.label}
    </Badge>
  );
}
