import type {
  PreviewAccessibilityAction,
  PreviewAccessibilityDocument,
  PreviewAccessibilityNode,
} from "@t3tools/contracts";

export type AccessibleControl = "activate" | "check" | "edit" | "select";

export interface AccessibleOption {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
}

export type AccessiblePlan =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "element";
      readonly tag: string;
      readonly attributes: Readonly<Record<string, string>>;
      /** Rendered as the element's own text; children are then not rendered. */
      readonly text?: string;
      /** A visible label wrapped around form fields. */
      readonly label?: string;
      readonly children: ReadonlyArray<PreviewAccessibilityNode>;
      readonly control: AccessibleControl | null;
      readonly value?: string;
      readonly checked?: boolean;
      readonly indeterminate?: boolean;
      readonly options?: ReadonlyArray<AccessibleOption>;
    };

const LANDMARK_TAGS: Record<string, string> = {
  main: "main",
  navigation: "nav",
  banner: "header",
  contentinfo: "footer",
  complementary: "aside",
  region: "section",
  article: "article",
  paragraph: "p",
  list: "ul",
  listitem: "li",
  blockquote: "blockquote",
  figure: "figure",
  code: "code",
  separator: "hr",
  term: "dt",
  definition: "dd",
};
const ARIA_CONTAINER_ROLES = new Set([
  "table",
  "grid",
  "treegrid",
  "row",
  "rowgroup",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "form",
  "search",
  "dialog",
  "alertdialog",
  "alert",
  "status",
  "log",
  "timer",
  "tablist",
  "tabpanel",
  "menu",
  "menubar",
  "toolbar",
  "tree",
  "radiogroup",
  "group",
  "note",
  "feed",
]);
const BUTTON_ROLES: Record<string, string | null> = {
  button: null,
  PopUpButton: null,
  ToggleButton: null,
  DisclosureTriangle: null,
  tab: "tab",
  menuitem: "menuitem",
  menuitemcheckbox: "menuitemcheckbox",
  menuitemradio: "menuitemradio",
  switch: "switch",
  option: null,
};
const FIELD_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);
const SAFE_LINK = /^(https?:|mailto:)/i;

const textOf = (node: PreviewAccessibilityNode): string =>
  node.role === "text"
    ? (node.name ?? "")
    : (node.name ?? (node.children ?? []).map(textOf).join(" ").trim());

const descendants = (node: PreviewAccessibilityNode, role: string): PreviewAccessibilityNode[] =>
  (node.children ?? []).flatMap((child) =>
    child.role === role ? [child] : descendants(child, role),
  );

const stateAttributes = (node: PreviewAccessibilityNode, inert: boolean) => {
  const attributes: Record<string, string> = {};
  if (node.description) attributes["aria-description"] = node.description;
  if (node.expanded !== undefined) attributes["aria-expanded"] = String(node.expanded);
  if (node.required) attributes["aria-required"] = "true";
  if (node.invalid) attributes["aria-invalid"] = "true";
  // aria-disabled keeps controls reachable so a reader can still find them.
  if (inert) attributes["aria-disabled"] = "true";
  return attributes;
};

/** How one streamed node renders locally. Pure, so web and the mobile WebView agree. */
export function planAccessibleNode(
  node: PreviewAccessibilityNode,
  canAct: boolean,
): AccessiblePlan | null {
  if (node.role === "text") return node.name ? { kind: "text", text: node.name } : null;
  const children = node.children ?? [];
  const inert = !canAct || node.disabled === true;
  const states = stateAttributes(node, inert);
  const named = (attributes: Record<string, string>) =>
    node.name ? { ...attributes, "aria-label": node.name } : attributes;
  const element = (
    tag: string,
    attributes: Record<string, string>,
    extra: Partial<Extract<AccessiblePlan, { kind: "element" }>> = {},
  ): AccessiblePlan => ({
    kind: "element",
    tag,
    attributes: { ...states, ...attributes },
    children,
    control: null,
    ...extra,
  });

  if (node.role === "heading") {
    const level = Math.min(Math.max(node.level ?? 2, 1), 6);
    return element(`h${level}`, {}, children.length > 0 ? {} : { text: node.name ?? "" });
  }
  if (node.role === "link") {
    const safe = node.url !== undefined && SAFE_LINK.test(node.url);
    return element("a", safe ? { href: node.url! } : { role: "link", tabindex: "0" }, {
      text: textOf(node) || node.url || "Link",
      children: [],
      control: "activate",
    });
  }
  if (node.role === "treeitem") {
    // Not a button: an expanded item holds nested items that stay their own controls.
    const attributes = named({ role: "treeitem", tabindex: "0" });
    if (node.selected !== undefined) attributes["aria-selected"] = String(node.selected);
    if (node.checked !== undefined) attributes["aria-checked"] = node.checked;
    return element(
      "div",
      attributes,
      children.length > 0
        ? { control: "activate" }
        : { text: node.name || "Tree item", control: "activate" },
    );
  }
  if (node.role in BUTTON_ROLES) {
    const role = BUTTON_ROLES[node.role];
    const attributes: Record<string, string> = { type: "button", ...(role ? { role } : {}) };
    if (node.pressed !== undefined) attributes["aria-pressed"] = node.pressed;
    if (node.checked !== undefined && role) attributes["aria-checked"] = node.checked;
    if (node.selected !== undefined && role === "tab") {
      attributes["aria-selected"] = String(node.selected);
    } else if (node.selected) {
      attributes["aria-current"] = "true";
    }
    return element("button", attributes, {
      text: textOf(node) || node.role,
      children: [],
      control: "activate",
    });
  }
  if (node.role === "checkbox" || node.role === "radio") {
    return element(
      "input",
      { type: node.role },
      {
        label: node.name ?? "",
        children: [],
        control: "check",
        checked: node.checked === "true",
        indeterminate: node.checked === "mixed",
      },
    );
  }
  const options =
    node.role === "combobox" || node.role === "listbox" ? descendants(node, "option") : [];
  if (options.length > 0) {
    return element(
      "select",
      node.role === "listbox" ? { size: String(Math.min(Math.max(options.length, 2), 8)) } : {},
      {
        label: node.name ?? "",
        children: [],
        control: "select",
        options: options.map((option) => ({
          id: option.id,
          label: textOf(option) || option.value || "Option",
          selected: option.selected === true,
          disabled: option.disabled === true,
        })),
      },
    );
  }
  if (FIELD_ROLES.has(node.role) || (node.editable && children.length === 0)) {
    const readOnly = inert || node.readonly === true;
    const attributes: Record<string, string> = readOnly ? { readonly: "" } : {};
    if (!node.multiline) {
      attributes.type = node.protected ? "password" : node.role === "searchbox" ? "search" : "text";
    }
    if (node.protected) attributes["aria-description"] = "Its value is hidden.";
    return element(node.multiline ? "textarea" : "input", attributes, {
      label: node.name ?? "",
      children: [],
      control: "edit",
      value: node.protected ? "" : (node.value ?? ""),
    });
  }
  if (node.role === "image" || node.role === "img" || node.role === "graphics-symbol") {
    return node.name
      ? element("span", { role: "img", "aria-label": node.name }, { children: [] })
      : null;
  }
  if (node.role === "document") {
    return element("section", { "aria-label": node.name ?? "Frame" });
  }
  const tag = LANDMARK_TAGS[node.role];
  if (tag) {
    const attributes = node.role === "region" || node.role === "navigation" ? named({}) : {};
    if (tag === "hr") return element("hr", {}, { children: [] });
    return element(tag, attributes);
  }
  if (ARIA_CONTAINER_ROLES.has(node.role)) {
    return element("div", named({ role: node.role }));
  }
  const fallback = children.length === 0 ? [node.name, node.value].filter(Boolean).join(": ") : "";
  if (children.length === 0 && !fallback) return null;
  return element("div", {}, fallback ? { text: fallback } : {});
}

/**
 * Moving an element blurs it, so obsolete children go first and the child
 * holding focus stays put while its siblings move around it.
 */
export function syncChildren(parent: Element, next: ReadonlyArray<Node>, focused: Node | null) {
  const keep = new Set(next);
  for (const child of Array.from(parent.childNodes)) {
    if (!keep.has(child)) parent.removeChild(child);
  }
  next.forEach((child, index) => {
    if (focused && child.parentNode === parent && child.contains(focused)) {
      while (parent.childNodes[index] !== child) {
        parent.insertBefore(parent.childNodes[index]!, child.nextSibling);
      }
    }
    if (parent.childNodes[index] !== child) {
      parent.insertBefore(child, parent.childNodes[index] ?? null);
    }
  });
}

export interface AccessibleDocumentView {
  /** `null` shows a loading message. Updates keep elements, focus and edits in place. */
  readonly update: (document: PreviewAccessibilityDocument | null, canAct: boolean) => void;
  readonly notice: (message: string) => void;
  readonly destroy: () => void;
}

const ACCESSIBLE_VIEW_NOT_CONTROLLER = "Take control of the browser to use the page.";

const STYLE = `
.t3-accessible-document { font: inherit; line-height: 1.5; padding: 12px; overflow-wrap: anywhere; }
.t3-accessible-document :is(h1,h2,h3,h4,h5,h6) { font-weight: 600; margin: 0.75em 0 0.25em; }
.t3-accessible-document h1 { font-size: 1.5em; } .t3-accessible-document h2 { font-size: 1.3em; }
.t3-accessible-document h3 { font-size: 1.15em; }
.t3-accessible-document :is(p, ul, blockquote, figure, section, nav, main, article, aside, header, footer) { margin: 0.4em 0; }
.t3-accessible-document ul { list-style: disc; padding-left: 1.5em; }
.t3-accessible-document a { color: inherit; text-decoration: underline; }
.t3-accessible-document :is(button, input, textarea, select) { font: inherit; color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 4px; padding: 2px 6px; margin: 2px 0; }
.t3-accessible-document input[type=checkbox], .t3-accessible-document input[type=radio] { margin-right: 6px; }
.t3-accessible-document label { display: block; margin: 4px 0; }
.t3-accessible-document label > span { margin-right: 6px; }
.t3-accessible-document [aria-disabled=true] { opacity: 0.7; }
.t3-accessible-document [role=row] { display: flex; gap: 12px; }
.t3-accessible-document > [role=status] { font-size: 0.85em; opacity: 0.8; margin: 0 0 8px; }
`;

interface Rendered {
  readonly node: Node;
  readonly signature: string;
  readonly control: Element | null;
}

/** Keyed DOM view of streamed documents. It never moves remote focus by itself. */
export function createAccessibleDocumentView(
  container: HTMLElement,
  options: { readonly onAction: (action: PreviewAccessibilityAction) => boolean },
): AccessibleDocumentView {
  const doc = container.ownerDocument;
  const style = doc.createElement("style");
  style.textContent = STYLE;
  const status = doc.createElement("p");
  status.setAttribute("role", "status");
  const body = doc.createElement("div");
  container.classList.add("t3-accessible-document");
  container.replaceChildren(style, status, body);
  const rendered = new Map<string, Rendered>();
  const nodes = new Map<string, PreviewAccessibilityNode>();
  let current: PreviewAccessibilityDocument | null = null;
  let canAct = false;
  let summary = "";

  const say = (message: string) => {
    status.textContent = message || summary;
  };
  const act = (action: Omit<PreviewAccessibilityAction, "type" | "document">) => {
    if (!current) return;
    const sent =
      canAct &&
      options.onAction({ type: "accessibilityAction", document: current.document, ...action });
    if (sent) return;
    // Put back local changes the page never saw, then say why.
    view.update(current, canAct);
    say(ACCESSIBLE_VIEW_NOT_CONTROLLER);
  };

  const render = (node: PreviewAccessibilityNode, seen: Set<string>): Node | null => {
    const plan = planAccessibleNode(node, canAct);
    if (!plan) return null;
    seen.add(node.id);
    nodes.set(node.id, node);
    const signature =
      plan.kind === "text" ? "#text" : `${plan.tag}:${plan.control}:${plan.attributes.type ?? ""}`;
    let entry = rendered.get(node.id);
    if (!entry || entry.signature !== signature) {
      entry = create(plan, node.id, signature);
      rendered.set(node.id, entry);
    }
    if (plan.kind === "text") {
      if (entry.node.textContent !== plan.text) entry.node.textContent = plan.text;
      return entry.node;
    }
    const element = entry.control as HTMLElement;
    // Copied: removing from the live attribute map while iterating it skips entries.
    for (const attribute of Array.from(element.attributes)) {
      if (
        attribute.name !== "data-node" &&
        attribute.name !== "data-dirty" &&
        attribute.name !== "data-server-value" &&
        !(attribute.name in plan.attributes)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    for (const [name, value] of Object.entries(plan.attributes)) {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    }
    if (entry.node !== element) {
      const label = (entry.node as HTMLElement).firstChild as HTMLElement;
      if (label.textContent !== (plan.label ?? "")) label.textContent = plan.label ?? "";
    }
    if (element instanceof HTMLInputElement && plan.control === "check") {
      element.checked = plan.checked === true;
      element.indeterminate = plan.indeterminate === true;
    } else if (
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      plan.control === "edit"
    ) {
      element.dataset.serverValue = plan.value ?? "";
      // An edit in progress wins over the page until it is committed or cancelled.
      if (!(element.dataset.dirty && doc.activeElement === element)) {
        delete element.dataset.dirty;
        if (element.value !== plan.value) element.value = plan.value ?? "";
      }
    } else if (element instanceof HTMLSelectElement && plan.options) {
      syncChildren(
        element,
        plan.options.map((option) => {
          const existing = [...element.options].find((each) => each.dataset.node === option.id);
          const item = existing ?? doc.createElement("option");
          item.dataset.node = option.id;
          item.value = option.id;
          if (item.textContent !== option.label) item.textContent = option.label;
          item.disabled = option.disabled;
          item.selected = option.selected;
          return item;
        }),
        null,
      );
    }
    if (plan.text !== undefined) {
      if (element.textContent !== plan.text) element.textContent = plan.text;
    } else if (plan.control === null || plan.control === "activate") {
      syncChildren(
        element,
        plan.children.flatMap((child) => {
          const childNode = render(child, seen);
          return childNode ? [childNode] : [];
        }),
        doc.activeElement,
      );
    }
    return entry.node;
  };

  const create = (plan: AccessiblePlan, id: string, signature: string): Rendered => {
    if (plan.kind === "text")
      return { node: doc.createTextNode(plan.text), signature, control: null };
    const element = doc.createElement(plan.tag);
    element.dataset.node = id;
    if (plan.label === undefined) return { node: element, signature, control: element };
    const label = doc.createElement("label");
    label.append(doc.createElement("span"), element);
    return { node: label, signature, control: element };
  };

  const nodeOf = (target: EventTarget | null) => {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-node]") : null;
    const id = element?.dataset.node;
    const node = id ? nodes.get(id) : undefined;
    return node && element ? { node, element } : null;
  };

  const onClick = (event: Event) => {
    const hit = nodeOf(event.target);
    if (!hit) return;
    const plan = planAccessibleNode(hit.node, canAct);
    if (plan?.kind !== "element" || (plan.control !== "activate" && plan.control !== "check"))
      return;
    // Local links and checkboxes must not change on their own; the page answers.
    event.preventDefault();
    if (hit.node.disabled) {
      say("That control is unavailable.");
      return;
    }
    act({ node: hit.node.id, action: "activate" });
  };
  const commit = (element: HTMLInputElement | HTMLTextAreaElement, submit: boolean) => {
    const hit = nodeOf(element);
    if (!hit || (!submit && element.value === element.dataset.serverValue)) return;
    delete element.dataset.dirty;
    act({
      node: hit.node.id,
      action: "setValue",
      value: element.value,
      ...(submit ? { submit } : {}),
    });
  };
  const onChange = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement) {
      const chosen = target.selectedOptions[0]?.dataset.node;
      if (chosen) act({ node: chosen, action: "activate" });
      return;
    }
    if (
      (target instanceof HTMLInputElement &&
        target.type !== "checkbox" &&
        target.type !== "radio") ||
      target instanceof HTMLTextAreaElement
    ) {
      if (target.dataset.dirty) commit(target, false);
    }
  };
  const onInput = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.dataset.dirty = "1";
    }
  };
  const onKeyDown = (event: Event) => {
    const keyboard = event as KeyboardEvent;
    const target = keyboard.target;
    if (keyboard.isComposing) return;
    if (target instanceof HTMLInputElement && keyboard.key === "Enter" && target.dataset.node) {
      if (target.type === "checkbox" || target.type === "radio") return;
      keyboard.preventDefault();
      commit(target, true);
    } else if (
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
      keyboard.key === "Escape" &&
      target.dataset.dirty
    ) {
      keyboard.preventDefault();
      keyboard.stopPropagation();
      delete target.dataset.dirty;
      target.value = target.dataset.serverValue ?? "";
    } else if (keyboard.key === "Enter" || keyboard.key === " ") {
      const hit = nodeOf(target);
      const role = hit?.element === target ? hit.element.getAttribute("role") : null;
      if (hit && (role === "treeitem" || (role === "link" && keyboard.key === "Enter"))) {
        keyboard.preventDefault();
        act({ node: hit.node.id, action: "activate" });
      }
    }
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("input", onInput);
  container.addEventListener("keydown", onKeyDown);

  const view: AccessibleDocumentView = {
    update: (document, nextCanAct) => {
      canAct = nextCanAct;
      if (document?.document !== current?.document) {
        rendered.clear();
        nodes.clear();
      }
      current = document;
      summary = !document
        ? "Loading the page's accessible view..."
        : document.truncated
          ? "Some page content could not be shown. The page may be too long or contain an unavailable frame."
          : "";
      say("");
      if (!document) {
        body.replaceChildren();
        return;
      }
      const seen = new Set<string>();
      nodes.clear();
      const root = render(document.root, seen);
      syncChildren(body, root ? [root] : [], doc.activeElement);
      for (const id of rendered.keys()) if (!seen.has(id)) rendered.delete(id);
    },
    notice: say,
    destroy: () => {
      container.removeEventListener("click", onClick);
      container.removeEventListener("change", onChange);
      container.removeEventListener("input", onInput);
      container.removeEventListener("keydown", onKeyDown);
      container.classList.remove("t3-accessible-document");
      container.replaceChildren();
      rendered.clear();
      nodes.clear();
    },
  };
  return view;
}
