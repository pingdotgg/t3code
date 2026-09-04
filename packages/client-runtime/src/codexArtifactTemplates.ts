export const CODEX_ARTIFACT_TEMPLATE_KINDS = [
  "document",
  "presentation",
  "spreadsheet",
  "site",
  "google-docs",
  "google-slides",
  "google-sheets",
  "image",
  "email",
  "slack",
] as const;

export type CodexArtifactTemplateKind = (typeof CODEX_ARTIFACT_TEMPLATE_KINDS)[number];

export const CODEX_ARTIFACT_TEMPLATE_GALLERY_KINDS = ["imagegen", "product-design"] as const;

export type CodexArtifactTemplateGalleryKind =
  (typeof CODEX_ARTIFACT_TEMPLATE_GALLERY_KINDS)[number];

export interface CodexArtifactTemplate {
  readonly artifactKind: CodexArtifactTemplateKind;
  readonly displayName: string;
  readonly galleryKind?: CodexArtifactTemplateGalleryKind;
  readonly skillDirectory: string;
  readonly skillName: string;
}

export const CODEX_ARTIFACT_TEMPLATE_LABEL_BY_KIND = {
  document: "Document template",
  presentation: "Presentation template",
  spreadsheet: "Spreadsheet template",
  site: "Site template",
  "google-docs": "Google Doc template",
  "google-slides": "Google Slides template",
  "google-sheets": "Google Sheet template",
  image: "Image template",
  email: "Email template",
  slack: "Slack template",
} satisfies Record<CodexArtifactTemplateKind, string>;

export type CodexArtifactTemplateAttributes = Readonly<Record<string, string | null | undefined>>;

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_REGEX = /^(?:\\\\[^\\]+\\[^\\]+|\/\/[^/]+\/[^/]+)/;

function isCodexArtifactTemplateKind(value: unknown): value is CodexArtifactTemplateKind {
  return CODEX_ARTIFACT_TEMPLATE_KINDS.some((kind) => kind === value);
}

function isCodexArtifactTemplateGalleryKind(
  value: unknown,
): value is CodexArtifactTemplateGalleryKind {
  return CODEX_ARTIFACT_TEMPLATE_GALLERY_KINDS.some((kind) => kind === value);
}

function isAbsoluteSkillDirectory(value: string): boolean {
  return (
    (value.startsWith("/") && !value.startsWith("//")) ||
    WINDOWS_DRIVE_PATH_REGEX.test(value) ||
    WINDOWS_UNC_PATH_REGEX.test(value)
  );
}

/** Mirrors the Codex result-card schema so malformed directives remain literal Markdown. */
export function resolveCodexArtifactTemplate(
  attributes: CodexArtifactTemplateAttributes | null | undefined,
): CodexArtifactTemplate | null {
  const artifactKind = attributes?.artifact_kind;
  const displayNameValue = attributes?.display_name;
  const displayName = typeof displayNameValue === "string" ? displayNameValue.trim() : undefined;
  const galleryKind = attributes?.gallery_kind;
  const skillDirectory = attributes?.skill_directory;
  const skillName = attributes?.skill_name;

  if (
    !isCodexArtifactTemplateKind(artifactKind) ||
    !displayName ||
    typeof skillDirectory !== "string" ||
    !isAbsoluteSkillDirectory(skillDirectory) ||
    typeof skillName !== "string" ||
    !skillName.startsWith("artifact-template-") ||
    (galleryKind !== undefined && !isCodexArtifactTemplateGalleryKind(galleryKind))
  ) {
    return null;
  }

  return {
    artifactKind,
    displayName,
    ...(galleryKind === undefined ? {} : { galleryKind }),
    skillDirectory,
    skillName,
  };
}

const USE_PROMPT_BY_KIND: Record<CodexArtifactTemplateKind, (skill: string) => string> = {
  document: (skill) => `Create a document using this ${skill} about…`,
  presentation: (skill) => `Create a presentation using the ${skill} template about…`,
  spreadsheet: (skill) => `Create a spreadsheet using this ${skill} about…`,
  site: (skill) => `Create a Site using this ${skill} about…`,
  "google-docs": (skill) => `Create a Google Doc using this ${skill} about…`,
  "google-slides": (skill) => `Create a Google Slides presentation using this ${skill} about…`,
  "google-sheets": (skill) => `Create a Google Sheet using this ${skill} about…`,
  image: (skill) => `Create an image using this ${skill} of…`,
  email: (skill) => `Draft an email using this ${skill} about…`,
  slack: (skill) => `Draft a Slack message using this ${skill} about…`,
};

export function codexArtifactTemplateUsePrompt(template: CodexArtifactTemplate): string {
  return USE_PROMPT_BY_KIND[template.artifactKind](`$${template.skillName}`);
}

export function codexArtifactTemplatePresentationLabel(kind: CodexArtifactTemplateKind): string {
  return CODEX_ARTIFACT_TEMPLATE_LABEL_BY_KIND[kind];
}

export function appendCodexArtifactTemplateUsePrompt(
  draft: string,
  template: CodexArtifactTemplate,
): string {
  const prompt = codexArtifactTemplateUsePrompt(template);
  const trimmedDraft = draft.trimEnd();
  const promptStart = trimmedDraft.length - prompt.length;
  const alreadyEndsWithPrompt =
    promptStart >= 0 &&
    trimmedDraft.slice(promptStart) === prompt &&
    (promptStart === 0 || /\s/.test(trimmedDraft[promptStart - 1] ?? ""));

  if (alreadyEndsWithPrompt) {
    return draft;
  }

  const needsLeadingSpace = draft.length > 0 && !/\s$/.test(draft);
  return `${draft}${needsLeadingSpace ? " " : ""}${prompt}`;
}
