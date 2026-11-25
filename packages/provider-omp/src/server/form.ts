import type { OrchestrationV2SecretRequestField } from "@t3tools/contracts";
import { parse, type DefaultTreeAdapterTypes } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
type Field = OrchestrationV2SecretRequestField;
type Values = Readonly<Record<string, string | ReadonlyArray<string>>>;

const isElement = (node: Node): node is Element => "tagName" in node;
const dropped = new Set(["script", "style", "template", "noscript", "iframe", "svg", "object"]);
const attr = (node: Element, name: string) =>
  node.attrs.find((entry) => entry.name === name)?.value;
const children = (node: Node) => ("childNodes" in node ? node.childNodes : []);
const text = (node: Node): string =>
  node.nodeName === "#text" && "value" in node
    ? node.value
    : isElement(node) && dropped.has(node.tagName)
      ? ""
      : children(node).map(text).join("");
const caption = (node: Node | undefined) =>
  node ? text(node).replace(/\s+/g, " ").trim().slice(0, 1024) : "";
const descendants = function* (node: Node): Iterable<Element> {
  for (const child of children(node)) {
    if (isElement(child)) {
      if (dropped.has(child.tagName)) continue;
      yield child;
    }
    yield* descendants(child);
  }
};
const ancestor = (element: Element, tagName: string) => {
  for (let parent = element.parentNode; parent && isElement(parent); parent = parent.parentNode) {
    if (parent.tagName === tagName) return parent;
  }
  return undefined;
};

export function readOmpForm(html: string) {
  if (html.length > 128_000) return undefined;
  const document = parse(html);
  const form = [...descendants(document)].find((node) => node.tagName === "form") ?? document;
  const elements = [...descendants(form)];
  const controls = elements.filter((node) =>
    ["input", "textarea", "select"].includes(node.tagName),
  );
  if (controls.length > 256) return undefined;
  const labels = new Map(
    elements
      .filter((node) => node.tagName === "label")
      .map((node) => [attr(node, "for"), caption(node)]),
  );
  const label = (element: Element) => {
    const id = attr(element, "id");
    return (
      caption(ancestor(element, "label")) ||
      (id ? labels.get(id) : undefined) ||
      attr(element, "aria-label") ||
      attr(element, "title")
    );
  };
  const fields = new Map<string, Field>();
  const validate = new Map<string, (value: string) => boolean>();
  const groups = new Map<string, { multiple: boolean; size: number; field: Field }>();
  for (const control of controls) {
    const name = attr(control, "name");
    if (
      !name ||
      !name.trim() ||
      name.length > 256 ||
      name !== name.trim() ||
      ["__proto__", "constructor", "prototype"].includes(name)
    )
      continue;
    const type = (attr(control, "type") ?? "text").toLowerCase();
    if (["hidden", "submit", "reset", "button", "file", "image"].includes(type)) continue;
    const required = attr(control, "required") !== undefined;
    const disabled = attr(control, "disabled") !== undefined;
    const base = { name, label: label(control) || name, secret: type === "password", required };
    if (type === "radio" || type === "checkbox") {
      const previous = groups.get(name);
      const value = attr(control, "value") ?? "on";
      const fieldset = ancestor(control, "fieldset");
      const legend =
        fieldset && [...descendants(fieldset)].find((element) => element.tagName === "legend");
      const field = {
        ...base,
        label: caption(legend) || name,
        required: required || previous?.field.required === true,
        choices: [
          ...(previous?.field.choices ?? []),
          ...(disabled ? [] : [{ value, label: label(control) || value }]),
        ],
        initialChoices: [
          ...(previous?.field.initialChoices ?? []),
          ...(!disabled && attr(control, "checked") !== undefined ? [value] : []),
        ],
      };
      groups.set(name, { multiple: type === "checkbox", size: (previous?.size ?? 0) + 1, field });
      fields.set(name, field);
      continue;
    }
    if (control.tagName === "select") {
      const options = [...descendants(control)].filter((element) => element.tagName === "option");
      if (options.length > 128) return undefined;
      const enabled = options.filter((option) => attr(option, "disabled") === undefined);
      const optionValue = (option: Element) => attr(option, "value") ?? caption(option);
      const choices = enabled.map((option) => ({
        value: optionValue(option),
        label: caption(option) || optionValue(option),
      }));
      const multi = attr(control, "multiple") !== undefined;
      const multiple = multi && options.length > 1;
      const selected = enabled
        .filter((option) => attr(option, "selected") !== undefined)
        .map(optionValue);
      const initialChoices =
        selected.length === 0 && !multi && choices[0]
          ? [choices[0].value]
          : multiple
            ? selected
            : selected.slice(0, 1);
      fields.set(name, { ...base, choices, multiple, initialChoices });
      continue;
    }
    const multiline = control.tagName === "textarea";
    const initialValue = multiline ? text(control) : (attr(control, "value") ?? "");
    fields.set(name, {
      ...base,
      multiline,
      placeholder: attr(control, "placeholder")?.slice(0, 1024) ?? "",
      ...(type !== "password" ? { initialValue: initialValue.slice(0, 8192) } : {}),
    });
    const minLength = Number(attr(control, "minlength") ?? 0);
    const maxLength = Number(attr(control, "maxlength") ?? Infinity);
    const min = Number(attr(control, "min") ?? -Infinity);
    const max = Number(attr(control, "max") ?? Infinity);
    validate.set(name, (value) => {
      if (value.trim() === "") return !required;
      if (value.length < minLength || value.length > maxLength) return false;
      if (type === "number" || type === "range") {
        const number = Number(value);
        return Number.isFinite(number) && number >= min && number <= max;
      }
      if (type === "email") return /^[^\s@]+@[^\s@]+$/.test(value);
      if (type === "url") return URL.canParse(value);
      return true;
    });
  }
  if (fields.size > 64) return undefined;
  for (const [name, group] of groups) {
    const multiple = group.multiple && group.size > 1;
    fields.set(name, {
      ...group.field,
      multiple,
      initialChoices: multiple
        ? group.field.initialChoices!
        : group.field.initialChoices!.slice(0, 1),
    });
  }
  const title =
    (isElement(form) ? label(form) : undefined) ||
    caption(elements.find((element) => /^h[1-6]$/.test(element.tagName)));
  const reason = elements
    .filter((element) => element.tagName === "p")
    .map(caption)
    .filter(Boolean)
    .join("\n")
    .slice(0, 4096);
  return {
    title,
    reason,
    fields: [...fields.values()],
    response(values: Values) {
      const data: Record<string, string | ReadonlyArray<string>> = Object.create(null);
      if (Object.keys(values).some((name) => !fields.has(name))) return undefined;
      for (const field of fields.values()) {
        const value = Object.hasOwn(values, field.name) ? values[field.name] : undefined;
        if (field.choices !== undefined) {
          const selected = typeof value === "string" ? [value] : (value ?? []);
          if (
            (field.required && selected.length === 0) ||
            (!field.multiple && selected.length > 1) ||
            new Set(selected).size !== selected.length ||
            selected.some((entry) => !field.choices!.some((choice) => choice.value === entry))
          )
            return undefined;
          if (field.multiple) data[field.name] = selected;
          else if (selected[0] !== undefined) data[field.name] = selected[0];
          continue;
        }
        const typed = value ?? "";
        if (typeof typed !== "string" || typed.length > 8192 || !validate.get(field.name)?.(typed))
          return undefined;
        data[field.name] = typed;
      }
      return { data };
    },
  };
}
