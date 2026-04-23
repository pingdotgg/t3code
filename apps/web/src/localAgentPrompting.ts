import type {
  EnvironmentApi,
  ServerLocalAgentCommand,
  ServerLocalAgentInventory,
} from "@harness/contracts";
import {
  parseLocalAgentCommandJsonDocument,
  parseLocalAgentCommandMarkdownDocument,
  parseLocalAgentSkillDocument,
  renderLocalAgentCommandPromptTemplate,
} from "@harness/shared/localAgents";

const LOCAL_SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

function normalizePromptAfterSkillRemoval(prompt: string): string {
  return prompt
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n +/g, "\n")
    .trim();
}

function parseStandaloneLocalCommandInvocation(
  prompt: string,
  inventory: ServerLocalAgentInventory,
): { command: ServerLocalAgentCommand; arguments: string } | null {
  const trimmedPrompt = prompt.trim();
  const match = /^\/([a-zA-Z][a-zA-Z0-9:_-]*)(?:\s+(.*))?$/s.exec(trimmedPrompt);
  if (!match) {
    return null;
  }

  const commandName = match[1] ?? "";
  const localCommand = inventory.commands.find((command) => command.name === commandName);
  if (!localCommand) {
    return null;
  }

  return {
    command: localCommand,
    arguments: match[2]?.trim() ?? "",
  };
}

async function readProjectFile(
  api: EnvironmentApi,
  cwd: string,
  relativePath: string,
): Promise<string> {
  const file = await api.projects.readFile({
    cwd,
    relativePath,
  });
  return file.contents;
}

function buildLocalSkillContextBlock(input: {
  skills: ReadonlyArray<{
    name: string;
    path: string;
    contents: string;
  }>;
  userPrompt: string;
}): string {
  const intro =
    input.skills.length === 1
      ? "Apply the following project-local skill while responding to the user's request."
      : "Apply the following project-local skills while responding to the user's request.";
  const skillBlocks = input.skills.map(
    (skill) =>
      `<project-skill name="${skill.name}" path="${skill.path}">\n${skill.contents}\n</project-skill>`,
  );

  return input.userPrompt.trim().length > 0
    ? `${intro}\n\n${skillBlocks.join("\n\n")}\n\nUser request:\n${input.userPrompt.trim()}`
    : `${intro}\n\n${skillBlocks.join("\n\n")}`;
}

async function expandLocalCommandPrompt(input: {
  api: EnvironmentApi;
  cwd: string;
  prompt: string;
  inventory: ServerLocalAgentInventory;
}): Promise<string> {
  const invocation = parseStandaloneLocalCommandInvocation(input.prompt, input.inventory);
  if (!invocation) {
    return input.prompt;
  }

  const contents = await readProjectFile(input.api, input.cwd, invocation.command.path);
  const parsed = invocation.command.path.endsWith("/command.json")
    ? parseLocalAgentCommandJsonDocument({
        contents,
        defaultName: invocation.command.name,
        path: invocation.command.path,
      })
    : parseLocalAgentCommandMarkdownDocument({
        contents,
        defaultName: invocation.command.name,
        path: invocation.command.path,
      });

  const promptTemplate = renderLocalAgentCommandPromptTemplate(
    parsed.promptTemplate,
    invocation.arguments,
  );
  if (!promptTemplate) {
    throw new Error(`Project command "${invocation.command.name}" did not resolve to a prompt.`);
  }

  return promptTemplate;
}

async function expandLocalSkillPrompt(input: {
  api: EnvironmentApi;
  cwd: string;
  prompt: string;
  inventory: ServerLocalAgentInventory;
}): Promise<string> {
  const localSkillByName = new Map(
    input.inventory.skills.map((skill) => [skill.name, skill] as const),
  );
  const orderedLocalSkillNames: string[] = [];
  const referencedLocalSkillNames = new Set<string>();
  const strippedPrompt = input.prompt.replace(
    LOCAL_SKILL_TOKEN_REGEX,
    (fullMatch, prefix: string, skillName: string) => {
      if (!localSkillByName.has(skillName)) {
        return fullMatch;
      }
      if (!referencedLocalSkillNames.has(skillName)) {
        referencedLocalSkillNames.add(skillName);
        orderedLocalSkillNames.push(skillName);
      }
      return prefix;
    },
  );

  if (orderedLocalSkillNames.length === 0) {
    return input.prompt;
  }

  const skillDocuments = await Promise.all(
    orderedLocalSkillNames.map(async (skillName) => {
      const skill = localSkillByName.get(skillName)!;
      const contents = await readProjectFile(input.api, input.cwd, skill.path);
      const parsed = parseLocalAgentSkillDocument({
        contents,
        defaultName: skill.name,
        path: skill.path,
      });
      if (!parsed.contents) {
        throw new Error(`Project skill "${skill.name}" is empty.`);
      }
      return {
        name: parsed.skill.name,
        path: parsed.skill.path,
        contents: parsed.contents,
      };
    }),
  );

  return buildLocalSkillContextBlock({
    skills: skillDocuments,
    userPrompt: normalizePromptAfterSkillRemoval(strippedPrompt),
  });
}

export async function expandProjectLocalAgentsPrompt(input: {
  api: EnvironmentApi;
  cwd: string;
  prompt: string;
  inventory: ServerLocalAgentInventory;
}): Promise<string> {
  const expandedCommandPrompt = await expandLocalCommandPrompt(input);
  return expandLocalSkillPrompt({
    ...input,
    prompt: expandedCommandPrompt,
  });
}
