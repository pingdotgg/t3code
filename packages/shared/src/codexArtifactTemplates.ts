const CODEX_ARTIFACT_TEMPLATE_KINDS = [
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

const CODEX_ARTIFACT_TEMPLATE_GALLERY_KINDS = ["imagegen", "product-design"] as const;

export type CodexArtifactTemplateGalleryKind =
  (typeof CODEX_ARTIFACT_TEMPLATE_GALLERY_KINDS)[number];

export interface CodexArtifactTemplate {
  readonly artifactKind: CodexArtifactTemplateKind;
  readonly displayName: string;
  readonly galleryKind?: CodexArtifactTemplateGalleryKind;
  readonly skillDirectory: string;
  readonly skillName: string;
}

const CODEX_ARTIFACT_TEMPLATE_LABEL_BY_KIND = {
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

export function codexArtifactTemplatePresentationLabel(kind: CodexArtifactTemplateKind): string {
  return CODEX_ARTIFACT_TEMPLATE_LABEL_BY_KIND[kind];
}

export const CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES = [
  "dataCodexArtifactTemplate",
  "dataArtifactKind",
  "dataDisplayName",
  "dataGalleryKind",
  "dataSkillDirectory",
  "dataSkillName",
] as const;

export function artifactTemplateFromHastProperties(
  properties: Readonly<Record<string, unknown>> | null | undefined,
): CodexArtifactTemplate | null {
  if (properties?.dataCodexArtifactTemplate !== "true") return null;
  const stringProperty = (name: string) => {
    const value = properties[name];
    return typeof value === "string" ? value : undefined;
  };
  return resolveCodexArtifactTemplate({
    artifact_kind: stringProperty("dataArtifactKind"),
    display_name: stringProperty("dataDisplayName"),
    gallery_kind: stringProperty("dataGalleryKind"),
    skill_directory: stringProperty("dataSkillDirectory"),
    skill_name: stringProperty("dataSkillName"),
  });
}
