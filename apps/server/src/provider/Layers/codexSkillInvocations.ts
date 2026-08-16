import type { ServerProviderSkill } from "@t3tools/contracts";
import { collectComposerSkillInvocations } from "@t3tools/shared/composerInlineTokens";

export type CodexSkillUserInput = {
  readonly type: "skill";
  readonly name: string;
  readonly path: string;
};

export type BindCodexSkillInvocationsResult =
  | { readonly ok: true; readonly inputs: ReadonlyArray<CodexSkillUserInput> }
  | { readonly ok: false; readonly names: readonly string[] };

function findCodexSkill(
  name: string,
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "path" | "enabled">>,
): Pick<ServerProviderSkill, "name" | "path" | "enabled"> | undefined {
  const lower = name.toLowerCase();
  const matches = skills.filter(
    (skill) => skill.name === name || skill.name.toLowerCase() === lower,
  );
  return matches.find((skill) => skill.enabled) ?? matches[0];
}

export function bindCodexSkillInvocations(
  prompt: string | undefined,
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "path" | "enabled">>,
): BindCodexSkillInvocationsResult {
  const invocations = collectComposerSkillInvocations(prompt ?? "");
  if (invocations.length === 0) {
    return { ok: true, inputs: [] };
  }

  const inputs: CodexSkillUserInput[] = [];
  const unknown: string[] = [];

  for (const name of invocations) {
    const skill = findCodexSkill(name, skills);
    if (!skill) {
      unknown.push(name);
      continue;
    }
    inputs.push({
      type: "skill",
      name: skill.name,
      path: skill.path,
    });
  }

  if (unknown.length > 0) {
    return { ok: false, names: unknown };
  }
  return { ok: true, inputs };
}
