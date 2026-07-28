import type { ModelSelection, WorkflowModelRouting, WorkflowTaskRole } from "@t3tools/contracts";

const ROLE_LABELS: Readonly<Record<WorkflowTaskRole, string>> = {
  explore: "codebase exploration and scoping",
  implement: "implementation and edits",
  verify: "verification, tests, and review",
};

export const WORKFLOW_TASK_ROLES = [
  "explore",
  "implement",
  "verify",
] as const satisfies ReadonlyArray<WorkflowTaskRole>;

export const EMPTY_WORKFLOW_MODEL_ROUTING: WorkflowModelRouting = {
  explore: null,
  implement: null,
  verify: null,
};

export function configuredWorkflowRouteCount(routing: WorkflowModelRouting): number {
  return WORKFLOW_TASK_ROLES.filter((role) => routing[role] !== null).length;
}

export function workflowModelRoutingInstructions(
  routing: WorkflowModelRouting,
  options?: {
    readonly nativeAgentNames?: Partial<Record<WorkflowTaskRole, string>>;
  },
): string | undefined {
  if (configuredWorkflowRouteCount(routing) === 0) {
    return undefined;
  }

  const routes = WORKFLOW_TASK_ROLES.map((role) => {
    const selection = routing[role];
    return selection
      ? `- ${role}: ${ROLE_LABELS[role]} -> ${selection.instanceId}/${selection.model}`
      : `- ${role}: ${ROLE_LABELS[role]} -> inherit the parent model`;
  }).join("\n");

  const nativeRoutes = WORKFLOW_TASK_ROLES.flatMap((role) => {
    const name = options?.nativeAgentNames?.[role];
    return name ? [`- ${role}: use the provider-native agent \`${name}\``] : [];
  });
  const executionPolicy =
    nativeRoutes.length > 0
      ? `For same-provider routes, use these configured native agents:\n${nativeRoutes.join("\n")}\nFor every other delegated task, call the SurgeCode MCP \`delegate_task\` tool and set its \`role\` to exactly one of \`explore\`, \`implement\`, or \`verify\`.`
      : "For every delegated task, call the SurgeCode MCP `delegate_task` tool and set its `role` to exactly one of `explore`, `implement`, or `verify`.";

  return `<workflow_model_routing>
The user configured cost-aware sub-agent routes for this workflow:
${routes}

${executionPolicy} The server enforces configured cross-provider routes. Prefer \`explore\` for repository discovery, \`implement\` for writing changes, and \`verify\` for tests or independent review. Do not use an unconfigured provider-native agent because it may silently inherit this parent model.
</workflow_model_routing>`;
}

export function workflowRouteFor(
  routing: WorkflowModelRouting,
  role: WorkflowTaskRole | undefined,
): ModelSelection | null {
  return role ? routing[role] : null;
}
