// Dev-only: makes `[data-copy]` elements editable and saves edits to source.
// Served by the copy-editor Vite plugin during `vite serve`; never built.
//
// Two editing modes:
// - inline: the element's rendered text is edited in place and mapped back
//   onto its source text runs;
// - markdown (`data-copy-format="markdown"`): focusing the section swaps in
//   its markdown source; leaving it saves the markdown and shows a preview
//   rendered with the section's style (`data-copy-style`) until the page's
//   own renderer catches up.

import config from "virtual:copy-editor/config";
import { marked } from "marked";
import type { MarkdownStyle } from "./index.ts";

const SAVE_ENDPOINT = "/__copy-editor/save";
const SOURCE_ENDPOINT = "/__copy-editor/source";
const REFRESH_EVENT = "copy-editor:refresh";
const SELECTOR = "[data-copy]";
const styles = config.styles as Record<string, MarkdownStyle>;

const controller = new AbortController();
const { signal } = controller;
const listen = <K extends keyof DocumentEventMap>(
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
  capture = false,
) => document.addEventListener(type, handler, { signal, capture });

const style = document.createElement("style");
style.textContent = `
  ${SELECTOR} { cursor: text; }
  ${SELECTOR}:hover { outline: 1px dashed rgb(255 120 80 / 0.7); outline-offset: 3px; }
  ${SELECTOR}:focus {
    outline: 2px solid rgb(255 120 80);
    outline-offset: 3px;
    background: rgb(255 120 80 / 0.08);
  }
  /* Source keeps the element's own font so the text doesn't jump; only
     multi-line markdown needs its line breaks shown. */
  :is([data-copy-editing], [data-copy-draft]) {
    white-space: pre-wrap;
  }
  [data-copy-draft] { outline: 2px dashed #d33 !important; }
  [data-copy-empty]:not([data-copy-editing]) { min-height: 1em; }
  [data-copy-empty]:not([data-copy-editing]):is(:hover, :focus)::before {
    content: "Add markdown…"; opacity: 0.45; font-style: italic;
  }
  #copy-editor-toast {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    max-width: 360px; padding: 8px 12px; border-radius: 8px;
    font: 600 12px/1.3 system-ui, sans-serif; color: #fff; background: #1f6f3a;
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.4);
    opacity: 0; transition: opacity 0.2s; pointer-events: none;
  }
  #copy-editor-toast[data-error] { background: #8c1d18; }
  #copy-editor-toast[data-show] { opacity: 1; }
  ${Object.values(styles)
    .map((s) => s.css ?? "")
    .join("\n")}
`;
const toast = document.createElement("div");
toast.id = "copy-editor-toast";
document.head.append(style);
document.body.append(toast);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
const notify = (message: string, error = false) => {
  toast.textContent = message;
  toast.toggleAttribute("data-error", error);
  toast.setAttribute("data-show", "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => toast.removeAttribute("data-show"),
    error ? 6000 : 1800,
  );
};

const isMarkdown = (el: HTMLElement) =>
  el.dataset.copyFormat === "markdown" || isInline(el);
/** Template copy edited as one line of inline markdown. */
const isInline = (el: HTMLElement) => el.dataset.copyFormat === "inline";

/**
 * Renders inline markdown, copying attributes (classes, scoped styles) from
 * the same tags in the element's previous rendering.
 */
const renderInline = (source: string, rendered: string) => {
  const previous = document.createElement("template");
  previous.innerHTML = rendered;
  const template = document.createElement("template");
  template.innerHTML = marked.parseInline(source, {
    async: false,
    gfm: true,
    breaks: true,
  });
  for (const node of template.content.querySelectorAll("*")) {
    const sample = previous.content.querySelector(node.tagName);
    for (const attr of sample?.attributes ?? []) {
      if (attr.name !== "href") node.setAttribute(attr.name, attr.value);
    }
  }
  return template.innerHTML;
};

const markEmpty = (el: HTMLElement) => {
  if (isMarkdown(el) && !el.dataset.copyEditing) {
    el.toggleAttribute("data-copy-empty", el.textContent?.trim() === "");
  }
};

const makeEditable = (el: HTMLElement) => {
  markEmpty(el);
  if (el.isContentEditable) return;
  // "true", not "plaintext-only": Chrome forces `white-space: pre-wrap` on
  // plaintext-only elements, which renders source line breaks. Rich-text
  // input is blocked below instead.
  el.contentEditable = "true";
  el.spellcheck = false;
};

// Content rendered outside Vite transforms (markdown, generated docs) marks
// its element with a trailing `<!--copy:ID-->` comment instead of an attribute.
const MARKER = /^copy:(.+)$/;
const claimMarkers = (root: Node) => {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const markers: Comment[] = [];
  if (root.nodeType === Node.COMMENT_NODE) markers.push(root as Comment);
  while (walker.nextNode()) markers.push(walker.currentNode as Comment);
  for (const marker of markers) {
    const id = MARKER.exec(marker.data)?.[1];
    const parent = marker.parentElement;
    if (!id || !parent) continue;
    parent.setAttribute("data-copy", id);
    marker.remove();
  }
};

const enableWithin = (root: ParentNode) => {
  claimMarkers(root as Node);
  if (root instanceof HTMLElement && root.matches(SELECTOR)) makeEditable(root);
  for (const el of root.querySelectorAll<HTMLElement>(SELECTOR))
    makeEditable(el);
};
enableWithin(document);

// Elements rendered later (client routing, framework HMR) become editable too.
const observer = new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === "attributes")
      enableWithin(record.target as HTMLElement);
    for (const node of record.addedNodes) {
      if (node instanceof HTMLElement) enableWithin(node);
      else if (node.nodeType === Node.COMMENT_NODE) {
        const parent = node.parentElement;
        claimMarkers(node);
        if (parent) enableWithin(parent);
      }
    }
  }
});
observer.observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["data-copy"],
});

const target = (event: Event) =>
  event.target instanceof Element
    ? event.target.closest<HTMLElement>(SELECTOR)
    : null;

const post = async (url: string, body: object) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((error: unknown) => ({
    ok: false,
    json: async () => ({ error: String(error) }),
  }));
  const json = (await res.json().catch(() => ({}))) as {
    file?: string;
    changed?: boolean;
    reload?: boolean;
    error?: string;
  };
  return { ok: res.ok, ...json };
};

// ── inline text edits ─────────────────────────────────────────────────────

const textNodes = (el: HTMLElement): string[] => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  while (walker.nextNode()) out.push((walker.currentNode as Text).data);
  return out;
};

/** Browsers type spaces as non-breaking ones at run edges; keep real ones. */
const plainSpaces = (after: string[], before: string[]) =>
  after.map((text, i) =>
    before[i]?.includes("\u00a0") ? text : text.replace(/\u00a0/g, " "),
  );

interface Snapshot {
  html: string;
  texts: string[];
}
const snapshots = new WeakMap<HTMLElement, Snapshot>();

const saveInline = async (el: HTMLElement) => {
  const snap = snapshots.get(el);
  if (!snap) return;
  snapshots.delete(el);
  const after = plainSpaces(textNodes(el), snap.texts);
  if (after.join("\u0000") === snap.texts.join("\u0000")) return;
  const result = await post(SAVE_ENDPOINT, {
    id: el.dataset.copy,
    before: snap.texts,
    after,
  });
  if (result.ok) {
    if (result.changed) notify(`Saved to ${result.file}`);
    if (result.reload) needsReload();
  } else {
    el.innerHTML = snap.html;
    notify(`Not saved: ${result.error ?? "unknown error"}`, true);
  }
};

// ── markdown sections ─────────────────────────────────────────────────────

interface MarkdownState {
  /** Rendered HTML to restore when leaving without changes. */
  rendered: string;
  /** The source the edit started from (sent back to detect staleness). */
  base?: string;
  /** Unsaved source kept after a failed save. */
  draft?: string;
  /** The page as served when editing started, to tell when it's rebuilt. */
  servedAtFocus?: Promise<string>;
}
const sections = new WeakMap<HTMLElement, MarkdownState>();
/** Elements that are themselves a single markdown block. */
const BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "BLOCKQUOTE",
  "TABLE",
  "PRE",
]);
/** Sections showing a preview until the page's renderer catches up. */
const previews = new Map<
  HTMLElement,
  { staleHtml: string; attempts: number }
>();
/** An edit changed the page's structure; reload once the server has it. */
let reloadPending = false;
/** The server has it, but an edit was in progress. */
let reloadWhenIdle = false;
/** The page as served before a structural edit, to tell when it changed. */
let servedBefore: Promise<string> | undefined;
const fetchPage = () =>
  fetch(location.href, { cache: "no-store" })
    .then((res) => (res.ok ? res.text() : ""))
    .catch(() => "");
/** `before`: the page as served before the edit, when already fetched. */
const needsReload = (before?: Promise<string>) => {
  reloadPending = true;
  servedBefore ??= before ?? fetchPage();
};
const busy = () =>
  document.querySelector("[data-copy-editing], [data-copy-draft]") !== null;

/**
 * Moves stylesheets out of a section before its content is replaced:
 * renderers such as Expressive Code load page-wide styles from inside the
 * first block that needs them.
 */
const hoistStyles = (el: HTMLElement) => {
  for (const node of el.querySelectorAll<HTMLElement>(
    'link[rel="stylesheet"], style',
  )) {
    const href = node.getAttribute("href");
    const present = href
      ? document.head.querySelector(
          `link[rel="stylesheet"][href="${CSS.escape(href)}"]`,
        )
      : null;
    if (!present) document.head.append(node.cloneNode(true));
  }
};

/** Normalized text of a code block, for matching rendered and preview code. */
const codeText = (pre: Element) =>
  (
    pre.querySelector("[data-code]")?.getAttribute("data-code") ??
    (pre as HTMLElement).innerText ??
    pre.textContent ??
    ""
  ).replace(/\s+/g, "");

const renderPreview = (
  source: string,
  styleName: string | undefined,
  rendered?: string,
) => {
  const preset = styleName ? styles[styleName] : undefined;
  let markdown = source;
  for (const [pattern, replacement] of preset?.rewrite ?? []) {
    markdown = markdown.replace(new RegExp(pattern, "g"), replacement);
  }
  const template = document.createElement("template");
  template.innerHTML = marked.parse(markdown, { async: false, gfm: true });
  for (const [tag, attrs] of Object.entries(preset?.elements ?? {})) {
    const selector = tag === "code" ? "code:not(pre code)" : tag;
    for (const node of template.content.querySelectorAll(selector)) {
      for (const [name, value] of Object.entries(attrs ?? {})) {
        if (name === "class")
          node.classList.add(...value.split(/\s+/).filter(Boolean));
        else node.setAttribute(name, value);
      }
    }
  }
  // Keep unchanged code blocks exactly as the page rendered them
  // (highlighting, frames, copy buttons) instead of the plain preview.
  if (rendered) {
    const previous = document.createElement("template");
    previous.innerHTML = rendered;
    const blocks = [...previous.content.children].filter((child) =>
      child.matches("pre, :has(pre)"),
    );
    for (const pre of template.content.querySelectorAll(":scope > pre")) {
      const text = codeText(pre);
      const match = blocks.findIndex((block) => codeText(block) === text);
      if (match === -1) continue;
      pre.replaceWith(blocks[match]!);
      blocks.splice(match, 1);
    }
  }
  return template.innerHTML;
};

/** Text just before the caret, to find the same spot in the source. */
const caretContext = (el: HTMLElement) => {
  const selection = getSelection();
  const node = selection?.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node))
    return "";
  return (node as Text).data.slice(0, selection!.anchorOffset);
};

const placeCaret = (el: HTMLElement, source: string, context: string) => {
  let at = 0;
  for (const size of [24, 12, 6]) {
    const needle = context.slice(-size);
    const i = needle.trim() ? source.indexOf(needle) : -1;
    if (i !== -1) {
      at = i + needle.length;
      break;
    }
  }
  const node = el.firstChild;
  if (!node) return;
  const range = document.createRange();
  range.setStart(node, Math.min(at, node.textContent?.length ?? 0));
  range.collapse(true);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
};

const enterSource = async (el: HTMLElement) => {
  if (el.dataset.copyEditing) return;
  const state: MarkdownState = sections.get(el) ?? { rendered: el.innerHTML };
  sections.set(el, state);
  el.dataset.copyEditing = "loading";

  if (state.draft === undefined) {
    const res = await fetch(
      `${SOURCE_ENDPOINT}?id=${encodeURIComponent(el.dataset.copy ?? "")}`,
    ).catch(() => undefined);
    const body = (await res?.json().catch(() => ({}))) as {
      source?: string;
      error?: string;
    };
    if (!res?.ok || body.source === undefined) {
      delete el.dataset.copyEditing;
      notify(`Can't edit: ${body.error ?? "unknown error"}`, true);
      return;
    }
    state.base = body.source;
    state.rendered = el.innerHTML;
    state.servedAtFocus = fetchPage();
  }
  if (document.activeElement !== el) {
    delete el.dataset.copyEditing;
    return;
  }
  const context = caretContext(el);
  const source = state.draft ?? state.base ?? "";
  hoistStyles(el);
  el.dataset.copyEditing = "source";
  el.removeAttribute("data-copy-draft");
  el.removeAttribute("data-copy-empty");
  el.textContent = source;
  placeCaret(el, source, context);
};

const cancelSource = (el: HTMLElement) => {
  const state = sections.get(el);
  if (!state || !el.dataset.copyEditing) return;
  state.draft = undefined;
  delete el.dataset.copyEditing;
  el.removeAttribute("data-copy-draft");
  el.innerHTML = state.rendered;
  markEmpty(el);
};

const leaveSource = async (el: HTMLElement) => {
  const state = sections.get(el);
  if (!state || el.dataset.copyEditing !== "source") {
    if (el.dataset.copyEditing === "loading") delete el.dataset.copyEditing;
    return;
  }
  const source = el.innerText.replace(/\u00a0/g, " ").replace(/\s+$/, "");
  delete el.dataset.copyEditing;
  if (source === (state.base ?? "").replace(/\s+$/, "")) {
    state.draft = undefined;
    el.innerHTML = state.rendered;
    markEmpty(el);
    return;
  }

  const id = el.dataset.copy ?? "";
  const staleHtml = state.rendered;
  const result = await post(SOURCE_ENDPOINT, { id, source, base: state.base });
  if (!result.ok) {
    state.draft = source;
    el.setAttribute("data-copy-draft", "");
    el.textContent = source;
    notify(`Not saved: ${result.error ?? "unknown error"}`, true);
    return;
  }
  const preview = isInline(el)
    ? renderInline(source, staleHtml)
    : renderPreview(source, el.dataset.copyStyle, staleHtml);
  if (isInline(el)) {
    el.innerHTML = preview;
  } else if (BLOCK_TAGS.has(el.tagName)) {
    // The section IS one block (e.g. a paragraph): show the preview's
    // contents in place, or reload if the edit turned it into other blocks.
    const template = document.createElement("template");
    template.innerHTML = preview;
    const [only, ...rest] = [...template.content.children];
    if (only?.tagName === el.tagName && rest.length === 0) {
      el.innerHTML = only.innerHTML;
    } else {
      // Now several blocks (e.g. a paragraph and a list): show them in its
      // place, then reload once the page is rebuilt so every block gets an id.
      notify(`Saved to ${result.file}`);
      el.replaceWith(template.content);
      needsReload(state.servedAtFocus);
      return;
    }
  } else {
    el.innerHTML = preview;
  }
  state.draft = undefined;
  state.base = source;
  state.rendered = el.innerHTML;
  markEmpty(el);
  if (result.changed) {
    notify(`Saved to ${result.file}`);
    previews.set(el, { staleHtml, attempts: 0 });
  }
  if (result.reload) needsReload();
};

/**
 * Swaps previews for the page's own rendering once the server has caught
 * up, or reloads when an edit changed the page's structure.
 */
const refresh = async () => {
  if (reloadPending) {
    // Wait until the server serves the changed page (its watchers may lag
    // behind the regeneration that triggered this refresh).
    const before = await servedBefore;
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await fetchPage()) !== before) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (busy()) reloadWhenIdle = true;
    else location.reload();
    return;
  }
  const res = await fetch(location.href, { cache: "no-store" }).catch(
    () => undefined,
  );
  if (!res?.ok) return;
  const fresh = new DOMParser().parseFromString(await res.text(), "text/html");
  claimMarkers(fresh.body);
  // Pair editable elements by position: ids encode source locations, which
  // shift when an edit changes the length of the text before them.
  const current = [...document.querySelectorAll<HTMLElement>(SELECTOR)];
  const next = [...fresh.querySelectorAll<HTMLElement>(SELECTOR)];
  if (current.length !== next.length) {
    // The edit added or removed blocks.
    if (busy()) reloadWhenIdle = true;
    else location.reload();
    return;
  }
  let retry = false;
  current.forEach((el, i) => {
    const incoming = next[i]!;
    if (el.dataset.copyEditing) return;
    if (el.dataset.copy !== incoming.dataset.copy) {
      el.dataset.copy = incoming.dataset.copy;
    }
    const preview = previews.get(el);
    if (!preview) return;
    if (incoming.innerHTML === preview.staleHtml && preview.attempts < 5) {
      // The server hasn't picked up the edited source yet.
      preview.attempts++;
      retry = true;
      return;
    }
    el.innerHTML = incoming.innerHTML;
    sections.set(el, { rendered: el.innerHTML });
    markEmpty(el);
    previews.delete(el);
  });
  if (retry) setTimeout(refresh, 1000);
};

// ── events ────────────────────────────────────────────────────────────────

listen("focusin", (event) => {
  const el = target(event);
  if (!el) return;
  if (isMarkdown(el)) void enterSource(el);
  else snapshots.set(el, { html: el.innerHTML, texts: textNodes(el) });
});

listen("keydown", (event) => {
  const el = target(event);
  if (!el) return;
  if (isMarkdown(el)) {
    if (event.key === "Escape") {
      cancelSource(el);
      el.blur();
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Markdown sections: Enter adds a line, Ctrl/Cmd+Enter saves.
      // One-line copy: Enter saves, Shift+Enter adds a line break (<br>).
      const save =
        event.metaKey || event.ctrlKey || (isInline(el) && !event.shiftKey);
      if (save) el.blur();
      else document.execCommand("insertLineBreak");
    } else if (event.key === "Tab") {
      event.preventDefault();
      document.execCommand("insertText", false, "  ");
    }
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    el.blur();
  } else if (event.key === "Escape") {
    const snap = snapshots.get(el);
    if (snap) el.innerHTML = snap.html;
    el.blur();
  }
});

// Clicking copy inside a link or button places the caret; Ctrl/Cmd+click
// still follows the link.
listen(
  "click",
  (event) => {
    if (!target(event) || event.ctrlKey || event.metaKey) return;
    if ((event.target as Element).closest("a, button")) event.preventDefault();
  },
  true,
);

// Editable elements are plain text: no bold/italic shortcuts or rich drops.
listen("beforeinput", (event) => {
  if (!target(event)) return;
  if (
    event.inputType.startsWith("format") ||
    event.inputType === "insertFromDrop"
  ) {
    event.preventDefault();
  }
});

// Paste as plain text.
listen("paste", (event) => {
  if (!target(event) || !event.clipboardData) return;
  event.preventDefault();
  document.execCommand(
    "insertText",
    false,
    event.clipboardData.getData("text/plain"),
  );
});

listen("focusout", async (event) => {
  const el = target(event);
  if (!el) return;
  if (isMarkdown(el)) await leaveSource(el);
  else await saveInline(el);
  if (reloadWhenIdle && !busy()) location.reload();
});

// ── hot reload ────────────────────────────────────────────────────────────

if (import.meta.hot) {
  import.meta.hot.on(REFRESH_EVENT, () => void refresh());
  // Editing this file hot-swaps the editor without a page reload.
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    controller.abort();
    observer.disconnect();
    clearTimeout(toastTimer);
    style.remove();
    toast.remove();
  });
}
