import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const BundledSkillId = Schema.Literals([
  "t3code-threads",
  "t3code-orchestration",
  "t3code-browser",
  "t3code-computer-use",
  "t3code-linear",
  "t3code-jira",
  "t3code-ios",
  "t3code-android",
  "t3code-workspace-setup",
]);
export const ManagedSkillStatus = Schema.Literals([
  "not_installed",
  "installed",
  "update_available",
  "modified",
  "unmanaged",
]);
export const ManagedSkill = Schema.Struct({
  id: BundledSkillId,
  title: Schema.String,
  description: Schema.String,
  requirements: Schema.optional(Schema.String),
  path: Schema.String,
  status: ManagedSkillStatus,
  fingerprint: Schema.String,
});
export const SkillInstallationTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  label: Schema.String,
  directory: Schema.String,
  skills: Schema.Array(ManagedSkill),
});
export const BundledSkillsCatalog = Schema.Struct({
  targets: Schema.Array(SkillInstallationTarget),
});
export type BundledSkillsCatalog = typeof BundledSkillsCatalog.Type;
export type ManagedSkill = typeof ManagedSkill.Type;

export const ManageBundledSkillInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  skillId: BundledSkillId,
  action: Schema.Literals(["install", "update", "remove"]),
  expectedFingerprint: Schema.String.check(Schema.isMaxLength(128)),
});
export type ManageBundledSkillInput = typeof ManageBundledSkillInput.Type;

export class SkillManagementError extends Schema.TaggedError<SkillManagementError>()(
  "SkillManagementError",
  {
    reason: Schema.Literals([
      "unsupported_provider",
      "conflict",
      "stale_state",
      "filesystem",
      "recovery_required",
    ]),
    path: Schema.optional(Schema.String),
    backupPath: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported_provider":
        return "Skill installation currently supports Codex and Claude providers.";
      case "conflict":
        return "This skill contains local changes or was installed outside T3 Code. Its files were preserved.";
      case "stale_state":
        return "The installed skill changed. Refresh its status before trying again.";
      case "recovery_required":
        return `The previous skill was preserved at ${this.backupPath}. Review this backup before trying again.`;
      case "filesystem":
        return `Could not access the skill files${this.path ? ` at ${this.path}` : ""}.`;
    }
  }
}
