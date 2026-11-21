/** The task roles `delegate_task` accepts. */
export type T3Role = "implementation" | "research" | "review" | "design" | "test" | "general";
export type Isolation = "shared" | "worktree";

export interface ClaudeModel {
  readonly slug: string;
  readonly effort: string;
}

interface RoleSpec {
  readonly name: string;
  readonly t3Role: T3Role;
  readonly isolation: Isolation;
  /** Held only by the role's own file, because T3 cannot limit a child's tools. */
  readonly readOnly: boolean;
  readonly model: ClaudeModel;
}

export interface Role extends RoleSpec {
  /** One line, from the role file's front matter. */
  readonly description: string;
  readonly file: string;
}

const ROLE_SOURCES = import.meta.glob<string>("../../roles/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The role files, by file name. */
export const roleFiles: ReadonlyMap<string, string> = new Map(
  Object.entries(ROLE_SOURCES).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text]),
);

// Models follow Anthropic's model guide, not omp's settings: routine lanes on Sonnet, security on
// Opus at high, mechanical steps on Haiku. No role uses Fable or xhigh.
const REVIEW: ClaudeModel = { slug: "claude-sonnet-5-5", effort: "medium" };
const SECURITY: ClaudeModel = { slug: "claude-opus-5-5", effort: "high" };
const SCOUT: ClaudeModel = { slug: "claude-sonnet-5-5", effort: "medium" };
const TASK: ClaudeModel = { slug: "claude-sonnet-5-5", effort: "medium" };
const SONIC: ClaudeModel = { slug: "claude-haiku-5-5", effort: "low" };
const DEFAULT: ClaudeModel = { slug: "claude-opus-5-5", effort: "medium" };

const spec = (
  name: string,
  t3Role: T3Role,
  isolation: Isolation,
  readOnly: boolean,
  model: ClaudeModel = DEFAULT,
): RoleSpec => ({ name, t3Role, isolation, readOnly, model });

const SPECS: ReadonlyArray<RoleSpec> = [
  spec("task", "implementation", "worktree", false, TASK),
  spec("scout", "research", "shared", true, SCOUT),
  spec("reviewer", "review", "shared", true, REVIEW),
  spec("security-reviewer", "review", "shared", true, SECURITY),
  spec("sonic", "implementation", "worktree", false, SONIC),
  spec("comment-sicko", "review", "shared", true),
  spec("poteto-agent", "general", "worktree", false),
  spec("egm-bootstrap-orchestrator", "general", "worktree", false),
  spec("egm-codebase-details", "review", "shared", true),
  spec("egm-comprehension", "review", "shared", true),
  spec("egm-design", "design", "shared", true),
  spec("egm-implementation-readiness", "review", "shared", true),
  spec("egm-structural", "review", "shared", true),
  spec("egm-style", "review", "shared", true),
  spec("egm-synthesizer", "general", "shared", false),
  spec("egm-zoom-out", "design", "shared", true),
];

function descriptionOf(file: string): string {
  const text = roleFiles.get(file);
  const line = text?.split("\n").find((entry) => entry.startsWith("description:"));
  if (line === undefined) throw new Error(`${file} has no description in its front matter`);
  return JSON.parse(line.slice("description:".length).trim());
}

export const ROLES: ReadonlyArray<Role> = SPECS.map((role) => ({
  ...role,
  file: `${role.name}.md`,
  description: descriptionOf(`${role.name}.md`),
}));

export interface RoleTarget {
  /** The instance the child runs on. It names the picked instance, never the orchestrator instance, which would give the child the orchestrator's rules. */
  readonly providerInstanceId?: string;
  /** Left out when the child takes the orchestrator's model. */
  readonly model?: string;
  readonly effort?: string;
}

export interface ResolvedRole extends Role {
  readonly target: RoleTarget;
  /** Why the role does not use its own model, or null. */
  readonly fallback: string | null;
}

export interface OrchestratorModel {
  readonly instanceId: string;
  readonly driver: string;
  /** The slugs the orchestrator's instance offers. */
  readonly offered: ReadonlyArray<string>;
}

/**
 * Each role keeps its Claude model when the orchestrator's instance offers it. A Codex
 * orchestrator's children inherit its model, and a Claude model the instance does not offer
 * falls back to the orchestrator's model. Every target names the picked instance.
 */
export function resolveRoles(
  roles: ReadonlyArray<Role>,
  orchestrator: OrchestratorModel,
): ReadonlyArray<ResolvedRole> {
  return roles.map((role): ResolvedRole => {
    const inherited = { providerInstanceId: orchestrator.instanceId };
    if (orchestrator.driver !== "claudeAgent") {
      return { ...role, target: inherited, fallback: null };
    }
    if (!orchestrator.offered.includes(role.model.slug)) {
      return {
        ...role,
        target: inherited,
        fallback: `${role.model.slug} is not offered by ${orchestrator.instanceId}, so it uses the orchestrator's model`,
      };
    }
    return {
      ...role,
      target: {
        providerInstanceId: orchestrator.instanceId,
        model: role.model.slug,
        effort: role.model.effort,
      },
      fallback: null,
    };
  });
}

/** The registry with each role on its own model, before any instance is known. */
export const DEFAULT_ROLES: ReadonlyArray<ResolvedRole> = ROLES.map((role) => ({
  ...role,
  target: { model: role.model.slug, effort: role.model.effort },
  fallback: null,
}));
