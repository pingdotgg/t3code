import type { WorktreeLocationMode } from "@t3tools/contracts";

export const WORKTREE_LOCATION_TEMPLATE_VARIABLES = [
  {
    token: "$T3_HOME",
    description: "Base T3 Code home directory.",
  },
  {
    token: "$PROJECT_DIRNAME",
    description: "Directory containing the project root.",
  },
  {
    token: "$PROJECT_NAME",
    description: "Final path segment of the project root.",
  },
  {
    token: "$WORKTREE_NAME",
    description: "Sanitized worktree branch name.",
  },
] as const;

export type WorktreeLocationTemplateVariable =
  (typeof WORKTREE_LOCATION_TEMPLATE_VARIABLES)[number]["token"];

export type WorktreeLocationTemplateContext = Record<WorktreeLocationTemplateVariable, string>;

export interface WorktreeLocationPreview {
  readonly preview: string | null;
  readonly error: string | null;
}

export interface ResolveWorktreeLocationInput {
  readonly mode: WorktreeLocationMode;
  readonly template: string;
  readonly context: WorktreeLocationTemplateContext;
  readonly defaultWorktreesDir: string;
}

export type ResolvedWorktreeLocation =
  | {
      readonly ok: true;
      readonly path: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

const TRAILING_SEPARATOR_PATTERN = /[\\/]+$/;
const LEADING_SEPARATOR_PATTERN = /^[\\/]+/;
const ABSOLUTE_TEMPLATE_VARIABLE_PREFIXES = ["$T3_HOME", "$PROJECT_DIRNAME"] as const;
const ABSOLUTE_TEMPLATE_VARIABLES = ["$T3_HOME", "$PROJECT_DIRNAME"] as const;

function trimTrailingSeparators(input: string): string {
  if (input === "/" || /^[A-Za-z]:[\\/]?$/.test(input)) {
    return input;
  }
  return input.replace(TRAILING_SEPARATOR_PATTERN, "");
}

function detectPathSeparator(input: string): "/" | "\\" {
  return input.includes("\\") && !input.includes("/") ? "\\" : "/";
}

function getPathSegments(input: string): string[] {
  return trimTrailingSeparators(input)
    .split(/[\\/]+/g)
    .filter((segment) => segment.length > 0);
}

function getPathBasename(input: string): string {
  const segments = getPathSegments(input);
  return segments.at(-1) ?? input;
}

function getPathDirname(input: string): string {
  const trimmed = trimTrailingSeparators(input);
  if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return trimmed;
  }

  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separatorIndex <= 0) {
    if (/^[A-Za-z]:[^\\/]+$/.test(trimmed)) {
      return `${trimmed.slice(0, 2)}\\`;
    }
    return separatorIndex === 0 ? trimmed.slice(0, 1) : ".";
  }

  return trimmed.slice(0, separatorIndex);
}

function joinPreviewPath(separator: "/" | "\\", ...parts: string[]): string {
  const firstPart = parts.find((part) => part.length > 0);
  if (!firstPart) return "";
  const restParts = parts.slice(parts.indexOf(firstPart) + 1);

  let result = firstPart;
  for (const part of restParts) {
    const normalizedPart = part
      .replace(LEADING_SEPARATOR_PATTERN, "")
      .replace(TRAILING_SEPARATOR_PATTERN, "");
    if (normalizedPart.length === 0) continue;
    if (!result.endsWith("/") && !result.endsWith("\\")) {
      result += separator;
    }
    result += normalizedPart;
  }
  return result;
}

function startsWithAbsoluteTemplatePrefix(input: string): boolean {
  if (input.startsWith("/") || input.startsWith("\\")) {
    return true;
  }
  return ABSOLUTE_TEMPLATE_VARIABLE_PREFIXES.some((variable) => {
    if (!input.startsWith(variable)) {
      return false;
    }
    const nextChar = input.slice(variable.length, variable.length + 1);
    return nextChar.length === 0 || nextChar === "/" || nextChar === "\\";
  });
}

export function getDefaultWorktreesDir(t3Home: string): string {
  return joinPreviewPath(detectPathSeparator(t3Home), t3Home, "worktrees");
}

export function createWorktreeLocationTemplateContext(input: {
  readonly t3Home: string;
  readonly projectRoot: string;
  readonly worktreeName: string;
}): WorktreeLocationTemplateContext {
  return {
    $T3_HOME: input.t3Home,
    $PROJECT_DIRNAME: getPathDirname(input.projectRoot),
    $PROJECT_NAME: getPathBasename(input.projectRoot),
    $WORKTREE_NAME: input.worktreeName,
  };
}

export function sanitizeWorktreeName(name: string): string {
  return name.replace(/\//g, "-");
}

export function validateWorktreeLocationTemplate(template: string): string | null {
  const normalized = template.trim();
  if (normalized.length === 0) {
    return "Enter a full path template.";
  }
  if (!startsWithAbsoluteTemplatePrefix(normalized)) {
    return "Custom worktree templates must start with $T3_HOME, $PROJECT_DIRNAME, /, or \\.";
  }
  if (
    ABSOLUTE_TEMPLATE_VARIABLES.some((variable) => {
      const firstIndex = normalized.indexOf(variable);
      return firstIndex > 0 || normalized.indexOf(variable, variable.length) >= 0;
    })
  ) {
    return "$T3_HOME and $PROJECT_DIRNAME can only appear at the start of the template.";
  }
  if (!normalized.includes("$WORKTREE_NAME")) {
    return "Custom worktree templates must include $WORKTREE_NAME.";
  }
  return null;
}

export function substituteWorktreeLocationTemplate(
  template: string,
  context: WorktreeLocationTemplateContext,
): string {
  const normalized = template.trim();
  let resolved = normalized;
  for (const variable of WORKTREE_LOCATION_TEMPLATE_VARIABLES) {
    resolved = resolved.split(variable.token).join(context[variable.token]);
  }
  return resolved;
}

export function resolveCustomWorktreeLocationTemplate(input: {
  readonly template: string;
  readonly context: WorktreeLocationTemplateContext;
}): ResolvedWorktreeLocation {
  const error = validateWorktreeLocationTemplate(input.template);
  if (error) {
    return {
      ok: false,
      error,
    };
  }
  return {
    ok: true,
    path: substituteWorktreeLocationTemplate(input.template, input.context),
  };
}

export function resolveWorktreeLocation(
  input: ResolveWorktreeLocationInput,
): ResolvedWorktreeLocation {
  const { context, defaultWorktreesDir, mode, template } = input;
  const projectSeparator = detectPathSeparator(context.$PROJECT_DIRNAME);
  const defaultWorktreesSeparator = detectPathSeparator(defaultWorktreesDir);

  switch (mode) {
    case "default":
      return {
        ok: true,
        path: joinPreviewPath(
          defaultWorktreesSeparator,
          defaultWorktreesDir,
          context.$PROJECT_NAME,
          context.$WORKTREE_NAME,
        ),
      };
    case "project-subdirectory":
      return {
        ok: true,
        path: joinPreviewPath(
          projectSeparator,
          context.$PROJECT_DIRNAME,
          `${context.$PROJECT_NAME}.worktrees`,
          context.$WORKTREE_NAME,
        ),
      };
    case "project-sibling":
      return {
        ok: true,
        path: joinPreviewPath(
          projectSeparator,
          context.$PROJECT_DIRNAME,
          `${context.$PROJECT_NAME}.${context.$WORKTREE_NAME}`,
        ),
      };
    case "custom":
      return resolveCustomWorktreeLocationTemplate({ template, context });
  }
}

export function renderWorktreeLocationPreview(input: {
  readonly mode: WorktreeLocationMode;
  readonly template: string;
  readonly context: WorktreeLocationTemplateContext;
}): WorktreeLocationPreview {
  const resolvedLocation = resolveWorktreeLocation({
    ...input,
    defaultWorktreesDir: getDefaultWorktreesDir(input.context.$T3_HOME),
  });
  return {
    preview: resolvedLocation.ok ? resolvedLocation.path : null,
    error: resolvedLocation.ok ? null : resolvedLocation.error,
  };
}
