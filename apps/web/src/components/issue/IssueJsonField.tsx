import { parseTree, type Node, type ParseError } from "jsonc-parser";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

type JsonEntry = { key: string; value: JsonNode };
type JsonNode =
  | { type: "text"; value: string }
  | { type: "number"; value: string }
  | { type: "true" | "false" | "null" }
  | { type: "list"; items: JsonNode[] }
  | { type: "object"; entries: JsonEntry[] };

const TYPES = {
  text: "Text",
  number: "Number",
  true: "true",
  false: "false",
  null: "null",
  object: "Object",
  list: "List",
} as const;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const PAGE = 100;

function isJsonNumber(raw: string) {
  NUMBER.lastIndex = 0;
  return NUMBER.exec(raw)?.[0] === raw;
}

function nestingDepth(text: string) {
  let depth = 0;
  let max = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "[" || char === "{") max = Math.max(max, ++depth);
    else if (char === "]" || char === "}") depth--;
  }
  return max;
}

function parseJson(text: string): JsonNode {
  if (nestingDepth(text) > 41) throw new RangeError("JSON is nested too deeply.");
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  if (!tree || errors.length > 0) throw new SyntaxError("Invalid JSON.");
  const convert = (node: Node, depth: number): JsonNode => {
    if (depth > 40) throw new RangeError("JSON is nested too deeply.");
    switch (node.type) {
      case "object":
        return {
          type: "object",
          entries: (node.children ?? []).map((property) => {
            const [key, value] = property.children!;
            return { key: key!.value as string, value: convert(value!, depth + 1) };
          }),
        };
      case "array":
        return {
          type: "list",
          items: (node.children ?? []).map((item) => convert(item, depth + 1)),
        };
      case "string":
        return { type: "text", value: node.value as string };
      case "number":
        return { type: "number", value: text.slice(node.offset, node.offset + node.length) };
      case "boolean":
        return { type: node.value ? "true" : "false" };
      default:
        return { type: "null" };
    }
  };
  return convert(tree, 0);
}

function serialize(node: JsonNode): string {
  switch (node.type) {
    case "text":
      return JSON.stringify(node.value);
    case "number":
      return isJsonNumber(node.value) ? node.value : "NaN";
    case "list":
      return `[${node.items.map(serialize).join(",")}]`;
    case "object":
      return `{${node.entries.map((entry) => `${JSON.stringify(entry.key)}:${serialize(entry.value)}`).join(",")}}`;
    default:
      return node.type;
  }
}

export function jsonFieldError(text: string, label: string) {
  if (text.length > 65_536) return `${label} is too large.`;
  let root: JsonNode;
  try {
    root = parseJson(text);
  } catch (error) {
    return error instanceof RangeError
      ? `${label} is nested too deeply.`
      : `Enter valid JSON for ${label}.`;
  }
  let count = 0;
  const visit = (node: JsonNode): string | null => {
    if (++count > 20_000) return `${label} is too large.`;
    if (node.type === "number" && !Number.isFinite(Number(node.value)))
      return `Enter a finite number in ${label}.`;
    if (node.type === "list") {
      for (const item of node.items) {
        const problem = visit(item);
        if (problem) return problem;
      }
    }
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const entry of node.entries) {
        if (!entry.key) return `Enter every key in ${label}.`;
        if (UNSAFE_KEYS.has(entry.key)) return `Rename the key "${entry.key}" in ${label}.`;
        if (keys.has(entry.key)) return `Remove the duplicate key "${entry.key}" in ${label}.`;
        keys.add(entry.key);
        const problem = visit(entry.value);
        if (problem) return problem;
      }
    }
    return null;
  };
  return visit(root);
}

function emptyNode(type: JsonNode["type"]): JsonNode {
  if (type === "text" || type === "number") return { type, value: "" };
  if (type === "list") return { type, items: [] };
  if (type === "object") return { type, entries: [] };
  return { type };
}

function TypeSelect({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id?: string | undefined;
  label: string;
  value: JsonNode["type"] | null;
  disabled: boolean;
  onChange: (type: JsonNode["type"]) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next: JsonNode["type"] | null) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger id={id} size="sm" aria-label={label}>
        <SelectValue>
          {(selected: JsonNode["type"] | null) => (selected ? TYPES[selected] : "Select…")}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {Object.entries(TYPES).map(([type, name]) => (
          <SelectItem key={type} value={type}>
            {name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function JsonNodeEditor({
  id,
  label,
  node,
  depth,
  disabled,
  onChange,
}: {
  id?: string | undefined;
  label: string;
  node: JsonNode;
  depth: number;
  disabled: boolean;
  onChange: (node: JsonNode) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const [shown, setShown] = useState(PAGE);
  const values =
    node.type === "object"
      ? node.entries.map((entry) => entry.value)
      : node.type === "list"
        ? node.items
        : null;
  const keys = node.type === "object" ? node.entries.map((entry) => entry.key) : null;
  const childLabel = (index: number) => `${label} › ${keys ? keys[index] : index + 1}`;
  const setValues = (next: JsonNode[], nextKeys = keys) =>
    onChange(
      nextKeys
        ? { type: "object", entries: next.map((value, at) => ({ key: nextKeys[at]!, value })) }
        : { type: "list", items: next },
    );
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <TypeSelect
          id={id}
          label={`${label} type`}
          value={node.type}
          disabled={disabled}
          onChange={(type) => {
            if (type !== node.type) onChange(emptyNode(type));
          }}
        />
        {node.type === "text" || node.type === "number" ? (
          <Input
            size="sm"
            disabled={disabled}
            aria-label={`${label} value`}
            aria-invalid={node.type === "number" && !isJsonNumber(node.value) ? true : undefined}
            inputMode={node.type === "number" ? "decimal" : undefined}
            value={node.value}
            maxLength={65_536}
            onChange={(event) => onChange({ ...node, value: event.target.value })}
          />
        ) : null}
        {values ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {values.length} {keys ? "entries" : "items"}
          </Button>
        ) : null}
      </div>
      {values && open ? (
        <div className="flex flex-col gap-2 border-l pl-3">
          {values.slice(0, shown).map((child, index) => (
            <div key={index} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                {keys ? (
                  <Input
                    size="sm"
                    disabled={disabled}
                    aria-label={`${label} key ${index + 1}`}
                    aria-invalid={
                      !keys[index] ||
                      UNSAFE_KEYS.has(keys[index]!) ||
                      keys.indexOf(keys[index]!) !== index
                        ? true
                        : undefined
                    }
                    value={keys[index]}
                    maxLength={65_536}
                    onChange={(event) =>
                      setValues(
                        values,
                        keys.map((key, at) => (at === index ? event.target.value : key)),
                      )
                    }
                  />
                ) : null}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  aria-label={`Remove ${childLabel(index)}`}
                  onClick={() =>
                    setValues(
                      values.filter((_, at) => at !== index),
                      keys?.filter((_, at) => at !== index),
                    )
                  }
                >
                  Remove
                </Button>
              </div>
              <JsonNodeEditor
                label={childLabel(index)}
                node={child}
                depth={depth + 1}
                disabled={disabled}
                onChange={(next) =>
                  setValues(values.map((item, at) => (at === index ? next : item)))
                }
              />
            </div>
          ))}
          {values.length > shown ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => setShown(shown + PAGE)}
            >
              Show {Math.min(PAGE, values.length - shown)} more
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => setValues([...values, emptyNode("text")], keys && [...keys, ""])}
          >
            {keys ? "Add entry" : "Add item"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function IssueJsonField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string | undefined) => void;
}) {
  const [draft, setDraft] = useState<{ text: string; root: JsonNode | null }>({
    text: "",
    root: null,
  });
  const [source, setSource] = useState(false);
  const root = (() => {
    if (draft.text === value) return draft.root;
    if (!value.trim()) return null;
    try {
      return parseJson(value);
    } catch {
      return undefined;
    }
  })();
  const edit = (next: JsonNode | null) => {
    const text = next ? serialize(next) : "";
    setDraft({ text, root: next });
    onChange(next ? text : undefined);
  };
  if (source || root === undefined)
    return (
      <div className="flex flex-col gap-1.5">
        <Textarea
          id={id}
          disabled={disabled}
          aria-label={`${label} source`}
          value={value}
          maxLength={65_536}
          onChange={(event) => {
            setSource(true);
            onChange(event.target.value);
          }}
        />
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || root === undefined}
            onClick={() => setSource(false)}
          >
            Edit as fields
          </Button>
          {root === undefined ? (
            <p className="text-xs text-muted-foreground">Fix the JSON to edit it as fields.</p>
          ) : null}
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-1.5">
      {root === null ? (
        <TypeSelect
          id={id}
          label={`${label} type`}
          value={null}
          disabled={disabled}
          onChange={(type) => edit(emptyNode(type))}
        />
      ) : (
        <JsonNodeEditor
          id={id}
          label={label}
          node={root}
          depth={0}
          disabled={disabled}
          onChange={edit}
        />
      )}
      <div className="flex gap-2">
        <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setSource(true)}>
          Edit source
        </Button>
        {root !== null ? (
          <Button size="xs" variant="ghost" disabled={disabled} onClick={() => edit(null)}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
