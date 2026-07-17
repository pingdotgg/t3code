import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import type { QueuedThreadMessage } from "../../state/thread-outbox-model";

export const SHOWCASE_PENDING_TASK_DEFINITIONS = [
  {
    projectId: "t3code",
    id: "offline-launch-checklist",
    text: "Ship the offline launch checklist before touchdown ✈️",
    branch: "feat/offline-launchpad",
    minutesAgo: 8,
  },
  {
    projectId: "react",
    id: "train-tunnel-suspense",
    text: "Polish the Suspense handoff for the train tunnel 🚇",
    branch: "perf/tunnel-handoff",
    minutesAgo: 27,
  },
] as const;

const FALLBACK_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;

export function buildShowcasePendingTasks(
  projects: ReadonlyArray<EnvironmentProject>,
  now: number,
): ReadonlyArray<QueuedThreadMessage> {
  return SHOWCASE_PENDING_TASK_DEFINITIONS.flatMap((definition) => {
    const project = projects.find((candidate) => String(candidate.id) === definition.projectId);
    if (!project) return [];

    return [
      {
        environmentId: project.environmentId,
        threadId: ThreadId.make(`showcase-pending-${definition.id}`),
        messageId: MessageId.make(`showcase-pending-message-${definition.id}`),
        commandId: CommandId.make(`showcase-pending-command-${definition.id}`),
        text: definition.text,
        attachments: [],
        modelSelection: project.defaultModelSelection ?? FALLBACK_MODEL_SELECTION,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        creation: {
          projectId: project.id,
          projectTitle: project.title,
          projectCwd: project.workspaceRoot,
          workspaceMode: "local" as const,
          branch: definition.branch,
          worktreePath: project.workspaceRoot,
        },
        createdAt: new Date(now - definition.minutesAgo * 60_000).toISOString(),
      },
    ];
  });
}
