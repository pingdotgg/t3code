import { createHash } from "node:crypto";

import { renderAgentsMd } from "./t3work-projectSetupContent.ts";
import {
  T3WORK_PROJECT_AGENTS_PATH,
  T3WORK_PROJECT_CONTEXT_ENTRYPOINT_PATH,
  T3WORK_PROJECT_CONTEXT_ROOT,
  T3WORK_PROJECT_PROFILE_MANIFEST_PATH,
  T3WORK_PROJECT_RECIPES_ROOT,
  T3WORK_PROJECT_SETUP_VERSION,
  T3WORK_PROJECT_SKILLS_ROOT,
  type ProjectSetupProfileDefinition,
  type T3WorkProjectSetupFile,
  type T3WorkProjectSetupManagedFileHashes,
  type T3WorkProjectSetupProfileManifest,
} from "./t3work-projectSetupShared.ts";

export type T3WorkProjectSetupPersistedState = {
  readonly profileId?: string;
  readonly managedFileHashes: T3WorkProjectSetupManagedFileHashes;
};

export type T3WorkProjectSetupWriteDecision = {
  readonly shouldWrite: boolean;
  readonly nextManagedHash?: string;
};

export function createT3WorkProjectSetupContentHash(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function renderLegacyAgentsMd(profile: ProjectSetupProfileDefinition): string {
  const technicalDepthLine =
    profile.communicationStyle.technicalDepth === "high"
      ? "Give implementation detail and verification notes when they materially change a decision."
      : profile.communicationStyle.technicalDepth === "medium"
        ? "Use only enough technical detail to explain tradeoffs, risks, or validation results."
        : "Use plain, non-technical language unless the user explicitly asks for implementation detail.";
  const complexityLine = profile.communicationStyle.hideImplementationComplexity
    ? "Hide low-level implementation complexity unless it changes the outcome or the user asks for it."
    : "Summarize the implementation approach clearly, but keep the final answer compact.";

  return `# t3work Project Agent Guide

## Conversation Style

- Keep replies short and direct.
- ${technicalDepthLine}
- ${complexityLine}
- Explain what changed, why it matters, and what the user should do next.

## Thread Naming

- Keep the thread title current as the topic changes.
- When a thread name no longer describes the work, rename it in a few words.
- Example: change "Initial question" to "Fix OAuth callback" after the work shifts there.

## Start With Project Context

Use these project files before asking the user to restate context:

- ${T3WORK_PROJECT_CONTEXT_ENTRYPOINT_PATH}
- ${T3WORK_PROJECT_CONTEXT_ROOT}/
- .t3work/references/reference-repositories.json
- ${T3WORK_PROJECT_PROFILE_MANIFEST_PATH}

## Durable Outputs

- Save durable project artifacts in the workspace, not only in chat.
- Prefer project-local recipes under ${T3WORK_PROJECT_RECIPES_ROOT}/.
- Prefer project-local skills under ${T3WORK_PROJECT_SKILLS_ROOT}/ for repeatable workflows.
- After a workflow succeeds and looks reusable, proactively offer to create or update a project skill or recipe.
- Offer first. Do not silently create project skills or recipes.

## Scope

- Keep work focused on this project.
- If project context is missing or stale, refresh ${T3WORK_PROJECT_CONTEXT_ROOT} before continuing.
`;
}

export function buildT3WorkProjectAgentsManagedRefresh(profile: ProjectSetupProfileDefinition) {
  const currentHash = createT3WorkProjectSetupContentHash(renderAgentsMd(profile));
  const legacyHash = createT3WorkProjectSetupContentHash(renderLegacyAgentsMd(profile));

  return {
    knownContentHashes:
      currentHash === legacyHash ? [currentHash] : ([legacyHash, currentHash] as const),
  };
}

export function buildT3WorkProjectSetupProfileManifest(
  profile: ProjectSetupProfileDefinition,
  managedFileHashes?: T3WorkProjectSetupManagedFileHashes,
): T3WorkProjectSetupProfileManifest {
  return {
    version: T3WORK_PROJECT_SETUP_VERSION,
    profileId: profile.id,
    title: profile.title,
    description: profile.description,
    audience: profile.audience,
    communicationStyle: profile.communicationStyle,
    recommendedSkillPackIds: profile.recommendedSkillPackIds,
    ...(managedFileHashes && Object.keys(managedFileHashes).length > 0
      ? { managedFileHashes }
      : {}),
  };
}

function toManagedFileHashes(value: unknown): T3WorkProjectSetupManagedFileHashes {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function readPersistedT3WorkProjectSetupState(
  value: string,
): T3WorkProjectSetupPersistedState {
  try {
    const parsed = JSON.parse(value);
    return {
      profileId: typeof parsed?.profileId === "string" ? parsed.profileId : undefined,
      managedFileHashes: toManagedFileHashes(parsed?.managedFileHashes),
    };
  } catch {
    return {
      managedFileHashes: {},
    };
  }
}

export function resolveT3WorkProjectSetupWriteDecision(input: {
  readonly file: T3WorkProjectSetupFile;
  readonly currentContents?: string;
  readonly persistedManagedHash?: string;
}): T3WorkProjectSetupWriteDecision {
  const nextManagedHash = input.file.managedRefresh
    ? createT3WorkProjectSetupContentHash(input.file.contents)
    : undefined;

  if (input.file.writeMode === "overwrite") {
    return {
      shouldWrite: true,
      ...(nextManagedHash ? { nextManagedHash } : {}),
    };
  }

  if (typeof input.currentContents !== "string") {
    return {
      shouldWrite: true,
      ...(nextManagedHash ? { nextManagedHash } : {}),
    };
  }

  if (!input.file.managedRefresh || !nextManagedHash) {
    return {
      shouldWrite: false,
    };
  }

  const currentHash = createT3WorkProjectSetupContentHash(input.currentContents);
  if (currentHash === nextManagedHash) {
    return {
      shouldWrite: false,
      nextManagedHash,
    };
  }

  if (
    typeof input.persistedManagedHash === "string" &&
    input.persistedManagedHash === currentHash
  ) {
    return {
      shouldWrite: true,
      nextManagedHash,
    };
  }

  if ((input.file.managedRefresh.knownContentHashes ?? []).includes(currentHash)) {
    return {
      shouldWrite: true,
      nextManagedHash,
    };
  }

  return {
    shouldWrite: false,
  };
}
