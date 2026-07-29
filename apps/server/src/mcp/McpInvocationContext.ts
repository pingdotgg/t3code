import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

/**
 * What a credential is allowed to do.
 *
 * `agents` is the local, provider-session capability: it can delegate work to
 * background agents and branch threads. `workspace` is the remote, read-only
 * capability handed to a ChatGPT Developer Mode connector — it can inspect the
 * thread's worktree and nothing else.
 *
 * They are deliberately disjoint rather than nested. A `workspace` credential
 * leaves this machine (OpenAI's backend calls the endpoint, not the browser),
 * so it must never carry the ability to start an agent.
 */
export type McpCapability = "agents" | "workspace";

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
