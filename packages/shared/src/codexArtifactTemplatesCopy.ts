import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { CodexArtifactTemplate, CodexArtifactTemplateKind } from "./codexArtifactTemplates.ts";

const PRESENTATION_LABEL_BY_KIND = {
  document: msg("Document template"),
  presentation: msg("Presentation template"),
  spreadsheet: msg("Spreadsheet template"),
  site: msg("Site template"),
  "google-docs": msg("Google Doc template"),
  "google-slides": msg("Google Slides template"),
  "google-sheets": msg("Google Sheet template"),
  image: msg("Image template"),
  email: msg("Email template"),
  slack: msg("Slack template"),
} satisfies Record<CodexArtifactTemplateKind, string>;

/** @public */
export function codexArtifactTemplatePresentationLabel(
  kind: CodexArtifactTemplateKind,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(PRESENTATION_LABEL_BY_KIND[kind]);
}

const USE_PROMPT_BY_KIND: Record<CodexArtifactTemplateKind, (skill: string) => string> = {
  document: (skill) => msg("Create a document using this {skill} about…", { skill }),
  presentation: (skill) =>
    msg("Create a presentation using the {skill} template about…", { skill }),
  spreadsheet: (skill) => msg("Create a spreadsheet using this {skill} about…", { skill }),
  site: (skill) => msg("Create a Site using this {skill} about…", { skill }),
  "google-docs": (skill) => msg("Create a Google Doc using this {skill} about…", { skill }),
  "google-slides": (skill) =>
    msg("Create a Google Slides presentation using this {skill} about…", { skill }),
  "google-sheets": (skill) => msg("Create a Google Sheet using this {skill} about…", { skill }),
  image: (skill) => msg("Create an image using this {skill} of…", { skill }),
  email: (skill) => msg("Draft an email using this {skill} about…", { skill }),
  slack: (skill) => msg("Draft a Slack message using this {skill} about…", { skill }),
};

export function codexArtifactTemplateUsePrompt(
  template: CodexArtifactTemplate,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(USE_PROMPT_BY_KIND[template.artifactKind](`$${template.skillName}`));
}

export function appendCodexArtifactTemplateUsePrompt(
  draft: string,
  template: CodexArtifactTemplate,
  resolve: MFunctionType = mFallback,
): string {
  const prompt = codexArtifactTemplateUsePrompt(template, resolve);
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
