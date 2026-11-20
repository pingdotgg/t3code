import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export function defaultRulesDir(env) {
  return env.OMP_KIT_RULES_DIR || NodePath.join(NodeOS.homedir(), ".omp", "agent", "rules");
}

// Only the frontmatter shapes the omp rules use: scalars and `- item` block lists.
function parseScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

export function parseFrontmatter(text) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") return { meta: {}, body: text.trim() };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { meta: {}, body: text.trim() };

  const meta = {};
  let listKey = null;
  for (const line of lines.slice(1, end)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      meta[listKey].push(parseScalar(item[1]));
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    if (pair[2] === "") {
      listKey = pair[1];
      meta[listKey] = [];
    } else {
      listKey = null;
      meta[pair[1]] = parseScalar(pair[2]);
    }
  }
  return {
    meta,
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);

// Mirrors omp's compileRuleCondition: a leading `(?ims)` becomes regex flags.
function compileCondition(pattern) {
  const inline = /^\(\?([ims]+)\)/.exec(pattern);
  return inline
    ? new RegExp(pattern.slice(inline[0].length), [...new Set(inline[1])].join(""))
    : new RegExp(pattern);
}

function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

const TOOL_TOKEN =
  /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i;

// omp's absent scope: assistant text plus any tool call, never thinking.
const DEFAULT_SCOPE = { text: true, anyTool: true, tools: [] };

export function parseScope(raw) {
  const tokens = asList(raw).flatMap((entry) => entry.split(","));
  if (tokens.length === 0) return DEFAULT_SCOPE;

  const scope = { text: false, anyTool: false, tools: [] };
  for (const token of tokens.map((t) => t.trim()).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (lower === "text") scope.text = true;
    else if (lower === "thinking") continue;
    else {
      const parsed = TOOL_TOKEN.exec(token)?.groups;
      if (!parsed) continue;
      const tool = (parsed.tool ?? (parsed.prefix ? undefined : parsed.bare))?.toLowerCase();
      const glob = parsed.path?.trim();
      if (!tool && !glob) scope.anyTool = true;
      else scope.tools.push({ tool, glob: glob && globToRegExp(glob) });
    }
  }
  return scope;
}

export function loadRules(dir) {
  let files;
  try {
    files = NodeFS.readdirSync(dir)
      .filter((file) => file.endsWith(".md"))
      .toSorted();
  } catch {
    return [];
  }

  const rules = [];
  for (const file of files) {
    const { meta, body } = parseFrontmatter(NodeFS.readFileSync(NodePath.join(dir, file), "utf8"));
    const patterns = asList(meta.condition);
    if (patterns.length === 0) continue;
    let conditions;
    try {
      conditions = patterns.map(compileCondition);
    } catch {
      continue;
    }
    const scope = parseScope(meta.scope);
    if (!scope.text && !scope.anyTool && scope.tools.length === 0) continue;
    rules.push({
      name: file.slice(0, -".md".length),
      description: meta.description ?? "",
      conditions,
      scope,
      // omp's global default is `always`.
      interruptMode: meta.interruptMode ?? "always",
      // Not an omp field: omp's rule parser ignores unknown frontmatter keys.
      approval: meta.approval,
      body,
    });
  }
  return rules;
}

const TOOL_ALIASES = {
  edit: ["edit", "multiedit"],
  write: ["write"],
  bash: ["bash"],
};

// omp names an MCP tool `mcp__<server>_<tool>` and folds the server name to [a-z_] (`linear-server` becomes `linear_server`), where Claude Code says `mcp__<server>__<tool>`, so one scope token can use either spelling.
const ompToolName = (claudeName) =>
  claudeName.replace(
    /^mcp__(.+?)__(.+)$/,
    (_, server, tool) =>
      `mcp__${server
        .replace(/[^a-z_]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")}_${tool}`,
  );

function scopeAllowsTool(scope, toolName, paths) {
  if (scope.anyTool) return true;
  const claudeName = toolName.toLowerCase();
  const names = [claudeName, ompToolName(claudeName)];
  return scope.tools.some(({ tool, glob }) => {
    if (tool && !(TOOL_ALIASES[tool] ?? [tool]).some((alias) => names.includes(alias))) {
      return false;
    }
    return !glob || paths.some((candidate) => glob.test(candidate));
  });
}

function pathCandidates(filePath, cwd) {
  if (!filePath) return [];
  const absolute = NodePath.resolve(cwd ?? "", filePath);
  return [filePath, absolute, NodePath.relative(cwd ?? "", absolute), NodePath.basename(absolute)];
}

const isMcpTool = (toolName) => toolName.startsWith("mcp__");

// The text omp matches for a tool call: new content for file tools, the command for Bash.
function toolText(toolName, input) {
  switch (toolName.toLowerCase()) {
    case "bash":
      return input.command ?? "";
    case "edit":
      return input.new_string ?? "";
    case "multiedit":
      return (input.edits ?? []).map((edit) => edit.new_string ?? "").join("\n");
    case "write":
      return input.content ?? "";
    default:
      // An MCP call matches by its name alone, so a word in its arguments cannot trigger a rule.
      return isMcpTool(toolName) ? toolName : JSON.stringify(input);
  }
}

const anyConditionMatches = (rule, text) =>
  rule.conditions.some((condition) => {
    condition.lastIndex = 0;
    return condition.test(text);
  });

export function matchToolRules(rules, { toolName, toolInput = {}, cwd }) {
  const paths = pathCandidates(toolInput.file_path, cwd);
  const text = toolText(toolName, toolInput);
  return rules.filter(
    (rule) => scopeAllowsTool(rule.scope, toolName, paths) && anyConditionMatches(rule, text),
  );
}

export function matchTextRules(rules, text) {
  return rules.filter((rule) => rule.scope.text && anyConditionMatches(rule, text));
}

export function interruptsTool(rule) {
  return rule.interruptMode === "always" || rule.interruptMode === "tool-only";
}

// Only an MCP call is a known write by name; a Bash command that mentions Linear is a guess, so it keeps the draft-first deny.
export function asksApproval(rule, toolName) {
  return rule.approval === "ask" && isMcpTool(toolName) && interruptsTool(rule);
}

export function interruptsText(rule) {
  return rule.interruptMode === "always" || rule.interruptMode === "prose-only";
}
