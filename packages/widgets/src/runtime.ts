/** The widget side of the MCP Apps bridge, plus what every Kompas widget shares. */

type Json = Record<string, unknown>;

let nextId = 0;
const pending = new Map<
  number,
  { readonly resolve: (value: Json) => void; readonly reject: (error: Error) => void }
>();

const post = (message: Json) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");

const request = (method: string, params: Json) =>
  new Promise<Json>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    post({ id, method, params });
  });

const themeListeners = new Set<() => void>();
export const onThemeChange = (listener: () => void) => void themeListeners.add(listener);

let locale = navigator.language;

const applyContext = (context: Json | undefined) => {
  if (context === undefined) return;
  const root = document.documentElement;
  const theme = context.theme;
  if (theme === "light" || theme === "dark") {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }
  if (typeof context.locale === "string") locale = context.locale;
  const styles = context.styles as { readonly variables?: Record<string, string> } | undefined;
  const own = context.kompas as Record<string, string> | undefined;
  for (const [name, value] of Object.entries({ ...styles?.variables, ...own })) {
    root.style.setProperty(name, value);
  }
  if (context.displayMode !== undefined) {
    root.dataset.mode = String(context.displayMode);
  }
  for (const listener of themeListeners) listener();
};

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data as Json | null;
  if (message?.jsonrpc !== "2.0") return;
  if (message.method === "ui/notifications/host-context-changed") {
    applyContext(message.params as Json);
    return;
  }
  if (message.method === "ui/resource-teardown") {
    post({ id: message.id, result: {} });
    return;
  }
  const waiting = typeof message.id === "number" ? pending.get(message.id) : undefined;
  if (waiting === undefined || message.method !== undefined) return;
  pending.delete(message.id as number);
  const error = message.error as { readonly message?: string } | undefined;
  if (error !== undefined) waiting.reject(new Error(error.message ?? "Request failed."));
  else waiting.resolve((message.result ?? {}) as Json);
});

/** Calls one of the widget's own tools and returns its data. */
export const callTool = async (name: string, args: Json): Promise<Json> => {
  const result = await request("tools/call", { name, arguments: args });
  if (result.isError === true) {
    const [block] = result.content as ReadonlyArray<{ readonly text?: string }>;
    throw new Error(block?.text || t("Something went wrong.", "Coś poszło nie tak."));
  }
  return (result.structuredContent ?? {}) as Json;
};

export const sendMessage = (text: string) =>
  request("ui/message", { role: "user", content: [{ type: "text", text }] });

/** Puts text in the composer, for the user to finish and send. */
export const askAbout = (text: string) => void request("kompas/host", { action: "draft", text });
export const openStudy = (deckId: string) =>
  void request("kompas/host", { action: "study", deckId });

export const t = (english: string, polish: string) =>
  locale.toLowerCase().startsWith("pl") ? polish : english;

export const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], "style">> & {
    readonly class?: string;
    readonly style?: string;
  } = {},
  ...children: ReadonlyArray<Child>
): HTMLElementTagNameMap[K] {
  const { class: className, style, ...rest } = props;
  const element = Object.assign(document.createElement(tag), rest);
  if (className !== undefined) element.className = className;
  if (style !== undefined) element.setAttribute("style", style);
  element.append(
    ...children.filter(
      (child): child is Node | string => child !== null && child !== undefined && child !== false,
    ),
  );
  return element;
}

export const button = (
  label: string,
  onclick: () => void,
  kind: "primary" | "plain" | "ghost" = "plain",
) => h("button", { type: "button", class: `button ${kind}`, onclick }, label);

/** The widget's frame: title, the shared full-screen and "ask about this" buttons, and content. */
export const card = (
  title: string,
  content: ReadonlyArray<Child>,
  options: { readonly ask?: string; readonly fullscreen?: boolean; readonly meta?: Child } = {},
) => {
  const tools = h("div", { class: "tools" }, options.meta);
  if (options.ask !== undefined) {
    const ask = options.ask;
    tools.append(button(t("Ask about this", "Zapytaj o to"), () => askAbout(ask), "ghost"));
  }
  if (options.fullscreen !== false) {
    const toggle = button(
      "⤢",
      () =>
        void request("ui/request-display-mode", {
          mode: document.documentElement.dataset.mode === "fullscreen" ? "inline" : "fullscreen",
        }),
      "ghost",
    );
    toggle.title = t("Full screen", "Pełny ekran");
    toggle.setAttribute("aria-label", toggle.title);
    tools.append(toggle);
  }
  return h(
    "section",
    { class: "card" },
    h("header", {}, h("h1", {}, title), tools),
    h("div", { class: "content" }, ...content),
  );
};

export const failure = (error: unknown) =>
  h("p", { class: "error" }, error instanceof Error ? error.message : String(error));

/** Connects to the host and hands the widget the data it was published with. */
export const start = async <Data>(render: (data: Data, root: HTMLElement) => void) => {
  const root = h("main");
  document.body.append(root);
  const reportSize = () =>
    post({
      method: "ui/notifications/size-changed",
      params: { height: Math.ceil(root.getBoundingClientRect().height) },
    });
  const context = await request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "kompas", version: "1" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  });
  applyContext(context.hostContext as Json | undefined);
  document.documentElement.lang = locale.slice(0, 2);
  post({ method: "ui/notifications/initialized", params: {} });
  const source = document.getElementById("widget-data")?.textContent;
  try {
    if (!source) throw new Error(t("This widget has no data.", "Ten widget nie ma danych."));
    render(JSON.parse(source) as Data, root);
  } catch (error) {
    root.replaceChildren(failure(error));
  }
  new ResizeObserver(reportSize).observe(root);
  reportSize();
};
