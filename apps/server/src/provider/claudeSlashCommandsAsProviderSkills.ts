import type { ServerProviderSlashCommand, ServerProviderSkill } from "@t3tools/contracts";

/**
 * Claude reports capabilities as slash commands from SDK init. The composer
 * `$` picker reads {@link ServerProviderSkill}; mirror the same inventory so
 * `$` works for Claude the way Codex does with `skills/list`.
 */
export function claudeSlashCommandsAsProviderSkills(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSkill> {
  return commands.map((command) => {
    const hint = command.input?.hint?.trim();
    const desc = command.description?.trim();
    const shortDescription = hint ?? desc;
    return {
      name: command.name,
      path: `claude-agent:///slash-command/${encodeURIComponent(command.name)}`,
      enabled: true,
      scope: "claude-agent",
      ...(desc ? { description: desc } : {}),
      ...(shortDescription ? { shortDescription } : {}),
    } satisfies ServerProviderSkill;
  });
}
