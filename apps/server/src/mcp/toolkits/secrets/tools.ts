import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as AgentSecrets from "../../../secrets/AgentSecrets.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    AgentSecrets.AgentSecrets,
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    Project.ProjectService,
  ],
};
export const SecretsToolkit = Toolkit.make(
  Tool.make("secret_list", {
    ...shared,
    description:
      "List items and op:// field references (no values) in this environment's Agent vaults (Settings → Secrets → Agent vaults), up to 200 per vault. Each vault has its own service-account token; no op sign-in, 1Password desktop app, or Secret provider is involved, so a failing `op whoami` or `op account list` says nothing here. Call this before saying a secret is unavailable or asking for one. Needs the op CLI on this machine. Optional vault filter. No approval mode; only shared vaults are accessible.",
    parameters: Schema.Struct({ vault: Schema.optional(Schema.String) }),
    success: Schema.Struct({ items: Schema.Array(AgentSecrets.SecretItem) }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("secret_run", {
    ...shared,
    description:
      "Run one shell command in your thread's cwd on this environment with Agent vault references from secret_list injected as env variables via each vault's own token (no op sign-in needed). env maps NAME to op://vault/item/field; ssh_keys loads private-key references into a temporary ssh-agent for this command only (Unix). Tokens never reach the command. Output is capped at 30,000 characters per stream and exact secret values are masked, including chunk boundaries; transformed values are NOT masked. Never print, encode, or exfiltrate secrets. Use this rather than requesting pasted credentials. timeout is seconds, default 120, max 1800.",
    parameters: Schema.Struct({
      command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120000)),
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      ssh_keys: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(16))),
      timeout: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1800 }))),
    }),
    success: AgentSecrets.SecretRunResult,
  })
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, true),
);
