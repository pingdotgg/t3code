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

const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

/** Small, deterministic glob matcher covering the workspace rule syntax. */
const globRegex = (glob: string): RegExp => {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === undefined) break;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end < 0) throw new Error("Unclosed character class");
      const contents = glob.slice(index + 1, end);
      if (contents.length === 0 || contents.includes("["))
        throw new Error("Invalid character class");
      source += `[${contents.replaceAll("\\", "\\\\")}]`;
      index = end;
    } else if (character === "{") {
      const end = glob.indexOf("}", index + 1);
      if (end < 0) throw new Error("Unclosed alternation");
      const alternatives = glob.slice(index + 1, end).split(",");
      if (alternatives.length < 2 || alternatives.some((part) => part.length === 0)) {
        throw new Error("Invalid alternation");
      }
      source += `(?:${alternatives.map(escapeRegex).join("|")})`;
      index = end;
    } else {
      source += escapeRegex(character);
    }
  }
  return new RegExp(`${source}$`);
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
    let globMatched = false;
    for (const glob of rule.globs) {
      try {
        const expression = globRegex(normalizeGlob(glob));
        globMatched ||= contextFiles.some((file) => expression.test(file));
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
    const bodyBytes = textEncoder.encode(rule.body).byteLength;
    const nextBytes = contentBytes + bodyBytes;
    if (nextBytes > maxBytes) {
      throw new AgentRuleContentOverflowError({
        limitBytes: maxBytes,
        actualBytes: nextBytes,
        ruleId: rule.id,
        scope: rule.scope,
      });
    }
    contentBytes = nextBytes;
    if (rule.body.length > 0) {
      chunks.push(`<!-- t3-agent-rule: ${rule.scope}/${rule.id} -->\n${rule.body}`);
    }
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
