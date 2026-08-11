import * as Schema from "effect/Schema";

import type {
  AgentProfileDocument,
  AgentProfileLocator,
  AgentRuleDocument,
} from "@t3tools/contracts";

/** The maximum amount of rule body text carried into one prompt. */
export const AGENT_RULE_CONTENT_MAX_BYTES = 64 * 1024;

export class AgentRuleContentOverflowError extends Schema.TaggedErrorClass<AgentRuleContentOverflowError>()(
  "AgentRuleContentOverflowError",
  {
    limitBytes: Schema.Int,
    actualBytes: Schema.Int,
    ruleId: Schema.String,
    scope: Schema.Literals(["environment", "project"]),
  },
) {
  override get message(): string {
    return `Agent rule content exceeds ${this.limitBytes} bytes (reached while adding ${this.scope}/${this.ruleId}; ${this.actualBytes} bytes).`;
  }
}

export const isAgentRuleContentOverflowError = Schema.is(AgentRuleContentOverflowError);
export { AgentRuleContentOverflowError as RuleContentOverflowError };

export class AgentRulePathError extends Schema.TaggedErrorClass<AgentRulePathError>()(
  "AgentRulePathError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Expected a workspace-relative path, received '${this.path}'.`;
  }
}

const isAgentRulePathError = Schema.is(AgentRulePathError);

export const AgentRuleMatchDiagnostic = Schema.Struct({
  code: Schema.Literals(["invalid-path", "invalid-glob"]),
  message: Schema.String,
  value: Schema.String,
});
export type AgentRuleMatchDiagnostic = typeof AgentRuleMatchDiagnostic.Type;

export interface AgentRuleMatchInput {
  readonly rules: readonly AgentRuleDocument[];
  readonly profile?: AgentProfileLocator | AgentProfileDocument;
  readonly profileRef?: AgentProfileLocator;
  readonly contextFiles?: readonly string[];
}

export interface AgentRuleMatchResult {
  readonly rules: readonly AgentRuleDocument[];
  readonly contextFiles: readonly string[];
  readonly diagnostics: readonly AgentRuleMatchDiagnostic[];
}

export interface AgentRuleCompilation {
  readonly rules: readonly AgentRuleDocument[];
  readonly content: string;
  readonly contentBytes: number;
  readonly diagnostics: readonly AgentRuleMatchDiagnostic[];
}

const textEncoder = new TextEncoder();

/**
 * Normalize a path supplied by a client or provider. This deliberately does
 * not resolve a path against the host filesystem: paths in prompts are only
 * workspace-relative names.
 */
export const normalizeWorkspaceRelativePath = (value: string): string => {
  const original = value;
  const candidate = value.trim().replaceAll("\\", "/");
  if (
    candidate.length === 0 ||
    candidate.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate) ||
    /^[A-Za-z]:\//.test(candidate) ||
    candidate.startsWith("//")
  ) {
    throw new AgentRulePathError({ path: original });
  }

  const parts: string[] = [];
  for (const part of candidate.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new AgentRulePathError({ path: original });
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) throw new AgentRulePathError({ path: original });
  return parts.join("/");
};

const normalizeGlob = (value: string): string => {
  const candidate = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    candidate.length === 0 ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:\//.test(candidate) ||
    candidate.startsWith("//")
  ) {
    throw new AgentRulePathError({ path: value });
  }
  if (candidate.split("/").some((part) => part === "..")) {
    throw new AgentRulePathError({ path: value });
  }
  return candidate;
};

type CharacterClassPart =
  | { readonly type: "character"; readonly value: string }
  | { readonly type: "range"; readonly from: string; readonly to: string };

type GlobToken =
  | { readonly type: "literal"; readonly value: string }
  | { readonly type: "star" }
  | { readonly type: "deep-star" }
  | { readonly type: "deep-star-directory" }
  | { readonly type: "single" }
  | {
      readonly type: "class";
      readonly negated: boolean;
      readonly parts: readonly CharacterClassPart[];
    }
  | { readonly type: "alternatives"; readonly values: readonly string[] };

const parseCharacterClass = (contents: string): GlobToken => {
  if (contents.length === 0 || contents.includes("[")) {
    throw new Error("Invalid character class");
  }

  const negated = contents.startsWith("^");
  const source = negated ? contents.slice(1) : contents;
  if (source.length === 0) throw new Error("Invalid character class");

  const parts: CharacterClassPart[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const value = source[index];
    if (value === undefined) break;
    const rangeEnd = source[index + 2];
    if (source[index + 1] === "-" && rangeEnd !== undefined) {
      if (value.codePointAt(0)! > rangeEnd.codePointAt(0)!) {
        throw new Error("Invalid character class range");
      }
      parts.push({ type: "range", from: value, to: rangeEnd });
      index += 2;
    } else {
      parts.push({ type: "character", value });
    }
  }
  return { type: "class", negated, parts };
};

/**
 * Parse the small, intentionally portable rule-glob grammar. This is not a
 * regular-expression compiler: matching uses the bounded state machine below,
 * so a persisted glob can never make the JavaScript regexp engine backtrack.
 */
const parseGlob = (glob: string): readonly GlobToken[] => {
  const tokens: GlobToken[] = [];
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === undefined) break;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          tokens.push({ type: "deep-star-directory" });
        } else {
          tokens.push({ type: "deep-star" });
        }
      } else {
        tokens.push({ type: "star" });
      }
      continue;
    }
    if (character === "?") {
      tokens.push({ type: "single" });
      continue;
    }
    if (character === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end < 0) throw new Error("Unclosed character class");
      tokens.push(parseCharacterClass(glob.slice(index + 1, end)));
      index = end;
      continue;
    }
    if (character === "{") {
      const end = glob.indexOf("}", index + 1);
      if (end < 0) throw new Error("Unclosed alternation");
      const values = glob.slice(index + 1, end).split(",");
      if (values.length < 2 || values.some((value) => value.length === 0)) {
        throw new Error("Invalid alternation");
      }
      tokens.push({ type: "alternatives", values });
      index = end;
      continue;
    }
    tokens.push({ type: "literal", value: character });
  }
  return tokens;
};

const characterClassMatches = (
  token: Extract<GlobToken, { readonly type: "class" }>,
  value: string,
): boolean => {
  const codePoint = value.codePointAt(0)!;
  const matches = token.parts.some((part) =>
    part.type === "character"
      ? part.value === value
      : codePoint >= part.from.codePointAt(0)! && codePoint <= part.to.codePointAt(0)!,
  );
  return token.negated ? !matches : matches;
};

/**
 * Match by visiting each pattern/path state at most once. This bounded
 * state-machine evaluation avoids the unbounded backtracking of a regexp
 * engine; rule glob and path fields are each capped at 512 UTF-16 code units
 * by the contract, including for adversarial repeated wildcards.
 */
const matchesGlob = (tokens: readonly GlobToken[], path: string): boolean => {
  const pending: Array<readonly [number, number, boolean]> = [[0, 0, true]];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const state = pending.pop();
    if (!state) break;
    const [tokenIndex, pathIndex, atDirectoryBoundary] = state;
    const key = `${tokenIndex}:${pathIndex}:${atDirectoryBoundary ? "boundary" : "within"}`;
    if (visited.has(key)) continue;
    visited.add(key);

    if (tokenIndex === tokens.length) {
      if (pathIndex === path.length) return true;
      continue;
    }
    const token = tokens[tokenIndex];
    if (!token) continue;
    const character = path[pathIndex];

    switch (token.type) {
      case "star":
        pending.push([tokenIndex + 1, pathIndex, true]);
        if (character !== undefined && character !== "/") {
          pending.push([tokenIndex, pathIndex + 1, true]);
        }
        break;
      case "deep-star":
        pending.push([tokenIndex + 1, pathIndex, true]);
        if (character !== undefined) pending.push([tokenIndex, pathIndex + 1, true]);
        break;
      case "deep-star-directory":
        if (atDirectoryBoundary) pending.push([tokenIndex + 1, pathIndex, true]);
        if (character !== undefined) {
          pending.push([tokenIndex, pathIndex + 1, character === "/"]);
        }
        break;
      case "literal":
        if (character === token.value) pending.push([tokenIndex + 1, pathIndex + 1, true]);
        break;
      case "single":
        if (character !== undefined && character !== "/") {
          pending.push([tokenIndex + 1, pathIndex + 1, true]);
        }
        break;
      case "class":
        if (
          character !== undefined &&
          character !== "/" &&
          characterClassMatches(token, character)
        ) {
          pending.push([tokenIndex + 1, pathIndex + 1, true]);
        }
        break;
      case "alternatives":
        for (const value of token.values) {
          if (path.startsWith(value, pathIndex)) {
            pending.push([tokenIndex + 1, pathIndex + value.length, true]);
          }
        }
        break;
    }
  }
  return false;
};

const isTargeted = (
  rule: AgentRuleDocument,
  profile: AgentProfileLocator | AgentProfileDocument | undefined,
): boolean => {
  if (!profile) return false;
  return rule.profiles.some(
    (candidate) => candidate.id === profile.id && candidate.scope === profile.scope,
  );
};

const isExplicitlyReferenced = (
  rule: AgentRuleDocument,
  profile: AgentProfileLocator | AgentProfileDocument | undefined,
): boolean =>
  profile !== undefined &&
  "rules" in profile &&
  rule.scope === profile.scope &&
  profile.rules.some(
    (reference) =>
      reference.id === rule.id && (rule.sourcePath === null || reference.path === rule.sourcePath),
  );

const ruleSort = (left: AgentRuleDocument, right: AgentRuleDocument): number =>
  (left.scope === right.scope ? 0 : left.scope === "environment" ? -1 : 1) ||
  right.priority - left.priority ||
  left.id.localeCompare(right.id);

/** Return matching rules in a stable scope/priority/id order. */
export const matchAgentRules = (input: AgentRuleMatchInput): AgentRuleMatchResult => {
  const diagnostics: AgentRuleMatchDiagnostic[] = [];
  const contextFiles: string[] = [];
  for (const file of input.contextFiles ?? []) {
    try {
      const normalized = normalizeWorkspaceRelativePath(file);
      if (!contextFiles.includes(normalized)) contextFiles.push(normalized);
    } catch (error) {
      if (isAgentRulePathError(error)) {
        diagnostics.push({ code: "invalid-path", message: error.message, value: file });
      } else throw error;
    }
  }

  const matching: AgentRuleDocument[] = [];
  for (const rule of input.rules) {
    if (rule.archivedAt !== null) continue;
    let globMatched = false;
    for (const glob of rule.globs) {
      try {
        const tokens = parseGlob(normalizeGlob(glob));
        globMatched ||= contextFiles.some((file) => matchesGlob(tokens, file));
      } catch (error) {
        diagnostics.push({
          code: "invalid-glob",
          message: error instanceof Error ? error.message : "Invalid rule glob.",
          value: glob,
        });
      }
    }
    const profile = input.profile ?? input.profileRef;
    if (
      rule.alwaysApply ||
      isTargeted(rule, profile) ||
      isExplicitlyReferenced(rule, profile) ||
      globMatched
    ) {
      matching.push(rule);
    }
  }

  return { rules: matching.sort(ruleSort), contextFiles, diagnostics };
};

/** Match and serialize rule bodies without reading or writing any files. */
export const compileAgentRules = (
  input: AgentRuleMatchInput,
  maxBytes = AGENT_RULE_CONTENT_MAX_BYTES,
): AgentRuleCompilation => {
  const matched = matchAgentRules(input);
  const chunks: string[] = [];
  let contentBytes = 0;
  for (const rule of matched.rules) {
    if (rule.body.length === 0) continue;
    const chunk = `<!-- t3-agent-rule: ${rule.scope}/${rule.id} -->\n${rule.body}`;
    const separator = chunks.length === 0 ? "" : "\n\n";
    const nextBytes =
      contentBytes +
      textEncoder.encode(separator).byteLength +
      textEncoder.encode(chunk).byteLength;
    if (nextBytes > maxBytes) {
      throw new AgentRuleContentOverflowError({
        limitBytes: maxBytes,
        actualBytes: nextBytes,
        ruleId: rule.id,
        scope: rule.scope,
      });
    }
    contentBytes = nextBytes;
    chunks.push(chunk);
  }
  return {
    rules: matched.rules,
    content: chunks.join("\n\n"),
    contentBytes,
    diagnostics: matched.diagnostics,
  };
};

export const matchRules = matchAgentRules;
export const compileRules = compileAgentRules;
