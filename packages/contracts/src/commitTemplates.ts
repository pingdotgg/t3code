import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

// Commit Mode Metadata

export const CommitModeConfig = Schema.Struct({
  value: Schema.Literals(["auto", "gitmoji", "standard", "custom"]),
  label: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type CommitModeConfig = typeof CommitModeConfig.Type;

export const COMMIT_MODES: ReadonlyArray<{
  readonly value: "auto" | "gitmoji" | "standard" | "custom";
  readonly label: string;
  readonly summary: string;
  readonly description: string;
}> = [
  {
    value: "standard",
    label: "Standard",
    summary: "Standard format",
    description:
      "Uses the Conventional Commits structure with type, optional scope, and description",
  },
  {
    value: "auto",
    label: "Auto",
    summary: "Infer from repo",
    description:
      "Analyzes past commit messages, selects the best example, and adapts to your repo's existing patterns",
  },
  {
    value: "gitmoji",
    label: "Gitmoji",
    summary: "Emoji + standard",
    description: "Uses Gitmoji emoji prefixes while following the standard conventional structure",
  },
  {
    value: "custom",
    label: "Custom",
    summary: "Your own rules",
    description: "Use a predefined template or provide your own instructions for custom formatting",
  },
] as const;

// Custom Commit Templates

export const CommitTemplateConfig = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  example: TrimmedNonEmptyString,
});
export type CommitTemplateConfig = typeof CommitTemplateConfig.Type;

export const CUSTOM_COMMIT_TEMPLATES: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly description: string;
  readonly example: string;
}> = [
  {
    id: "simple",
    label: "Simple",
    prompt: "Simple git message: imperative subject only, no prefix",
    description: "Plain readable fallback when you do not need automated parsing",
    example: "add login validation",
  },
  {
    id: "standard",
    label: "Standard",
    prompt: "Standard commit format (Conventional Commits): '<type>(<scope>): <subject>'",
    description: "Most common machine-readable format for changelogs and release tooling",
    example: "feat(auth): add login validation",
  },
  {
    id: "standard-ticket",
    label: "Standard + Ticket",
    prompt:
      "Conventional Commits with issue reference: '<type>(<scope>): <subject>' + body with 'Closes #<number>'",
    description: "Best for GitHub Issues - paste the issue URL or #number and it will be included",
    example: "feat(auth): add login validation\n\nCloses #1234",
  },
] as const;
