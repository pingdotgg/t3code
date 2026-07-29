import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

/**
 * What a credential is allowed to do.
 *
 * `agents` is the local, provider-session capability: it can delegate work to
 * background agents and branch threads. The `workspace*` family is what a
 * ChatGPT Developer Mode connector gets:
 *
 *   - `workspace`       — read-only repository inspection.
 *   - `workspace-write` — file mutations (write/edit/patch), each still
 *     subject to the thread's runtime mode and the approval flow.
 *   - `workspace-bash`  — shell commands in the worktree, same gating.
 *
 * They are deliberately disjoint from `agents` rather than nested. A
 * workspace credential leaves this machine (OpenAI's backend calls the
 * endpoint, not the browser), so it must never carry the ability to start an
 * agent. The write/bash split exists so the settings dropdown maps one-to-one
 * onto capabilities baked into the token — downgrading access in settings and
 * starting a new session is sufficient to shrink what an already-pasted
 * connector URL can do.
 */
export type McpCapability = "agents" | "workspace" | "workspace-write" | "workspace-bash";

/** Maps the provider settings access level onto connector capabilities. */
export const workspaceCapabilitiesForAccess = (
  access: "read" | "write" | "full",
): ReadonlyArray<McpCapability> =>
  access === "full"
    ? ["workspace", "workspace-write", "workspace-bash"]
    : access === "write"
      ? ["workspace", "workspace-write"]
      : ["workspace"];

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}
