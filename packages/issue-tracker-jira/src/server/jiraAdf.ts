import type { IssueRichBody } from "@t3tools/contracts";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function boundedJiraJson(value: unknown): void {
  let count = 0;
  let characters = 0;
  const visit = (current: unknown, depth: number) => {
    if (++count > 20_000 || depth > 40) throw new Error("Jira JSON exceeds its structure limit.");
    if (typeof current === "string") {
      characters += current.length;
      if (characters > 262_144) throw new Error("Jira JSON exceeds its text limit.");
    } else if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Invalid Jira number.");
    } else if (Array.isArray(current)) {
      for (const entry of current) visit(entry, depth + 1);
    } else if (object(current)) {
      for (const [key, entry] of Object.entries(current)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new Error("Invalid Jira JSON key.");
        characters += key.length;
        visit(entry, depth + 1);
      }
    } else if (current !== null && typeof current !== "boolean") {
      throw new Error("Invalid Jira JSON value.");
    }
  };
  visit(value, 0);
}

export function validateJiraAdf(value: unknown): Record<string, unknown> {
  boundedJiraJson(value);
  if (
    !object(value) ||
    value.type !== "doc" ||
    value.version !== 1 ||
    !Array.isArray(value.content)
  )
    throw new Error("Invalid Jira document root.");
  let nodes = 0;
  let text = 0;
  const node = (value: unknown, depth: number, root = false) => {
    if (++nodes > 10_000 || depth > 32 || !object(value))
      throw new Error("Invalid Jira document structure.");
    if (typeof value.type !== "string" || !/^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(value.type))
      throw new Error("Invalid Jira document node type.");
    if (!root && value.type === "doc") throw new Error("Invalid nested Jira document.");
    if (value.attrs !== undefined && !object(value.attrs))
      throw new Error("Invalid Jira attributes.");
    if (value.type === "heading") {
      const level = object(value.attrs) ? value.attrs.level : undefined;
      if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 6)
        throw new Error("Invalid Jira heading level.");
    }
    if (value.type === "text") {
      if (typeof value.text !== "string" || value.text.length === 0 || value.content !== undefined)
        throw new Error("Invalid Jira text node.");
      text += value.text.length;
      if (text > 65_536) throw new Error("Jira document exceeds its text limit.");
    } else if (value.text !== undefined) throw new Error("Invalid Jira node text.");
    if (value.marks !== undefined) {
      if (!Array.isArray(value.marks) || value.marks.length > 100)
        throw new Error("Invalid Jira marks.");
      const types = value.marks.map((mark) => {
        if (
          !object(mark) ||
          typeof mark.type !== "string" ||
          !/^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(mark.type) ||
          (mark.attrs !== undefined && !object(mark.attrs))
        )
          throw new Error("Invalid Jira mark.");
        return mark.type;
      });
      if (types.includes("code") && types.some((type) => type !== "code" && type !== "link"))
        throw new Error("Invalid Jira code mark combination.");
    }
    if (value.content !== undefined) {
      if (!Array.isArray(value.content)) throw new Error("Invalid Jira node content.");
      for (const child of value.content) {
        if (
          value.type === "codeBlock" &&
          (!object(child) ||
            child.type !== "text" ||
            (child.marks !== undefined && (!Array.isArray(child.marks) || child.marks.length > 0)))
        )
          throw new Error("Invalid Jira code block content.");
        node(child, depth + 1);
      }
    }
  };
  node(value, 0, true);
  if (JSON.stringify(value).length > 262_144)
    throw new Error("Jira document exceeds its wire limit.");
  return value;
}

export function jiraRichBody(
  value: unknown,
  deployment: "cloud" | "data-center" = "cloud",
): IssueRichBody | undefined {
  if (deployment === "data-center")
    return value === null || (typeof value === "string" && value.length <= 65_536)
      ? { format: "jira-wiki", document: value ?? "" }
      : undefined;
  if (value === null || value === undefined || typeof value === "string") return undefined;
  try {
    return { format: "adf", document: JSON.stringify(validateJiraAdf(value)) };
  } catch {
    return undefined;
  }
}

export function parseJiraRichBody(
  value: IssueRichBody,
  deployment: "cloud" | "data-center" = "cloud",
  comment = false,
): Record<string, unknown> | string {
  if (deployment === "data-center") {
    if (
      value.format !== "jira-wiki" ||
      typeof value.document !== "string" ||
      value.document.length > 65_536 ||
      (comment && !value.document.trim())
    )
      throw new Error("Invalid Jira wiki body.");
    return value.document;
  }
  if (
    value.format !== "adf" ||
    typeof value.document !== "string" ||
    value.document.length > 262_144
  )
    throw new Error("Invalid Jira rich body.");
  return validateJiraAdf(JSON.parse(value.document));
}
