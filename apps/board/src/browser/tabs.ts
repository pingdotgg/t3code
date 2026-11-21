export interface Tab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface TabsState {
  readonly tabs: ReadonlyArray<Tab>;
  readonly activeId: string | null;
}

export type TabsAction =
  | { readonly type: "open"; readonly id: string; readonly url: string }
  | { readonly type: "close"; readonly id: string }
  | { readonly type: "activate"; readonly id: string }
  | {
      readonly type: "update";
      readonly id: string;
      readonly patch: Partial<Omit<Tab, "id">>;
    };

export const EMPTY_TABS: TabsState = { tabs: [], activeId: null };

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open":
      return {
        tabs: [
          ...state.tabs,
          {
            id: action.id,
            url: action.url,
            title: "",
            loading: action.url !== "",
            canGoBack: false,
            canGoForward: false,
          },
        ],
        activeId: action.id,
      };
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      if (state.activeId !== action.id) return { tabs, activeId: state.activeId };
      // The tab that slides into the closed one's place, or the one before it at the end.
      return { tabs, activeId: (tabs[index] ?? tabs[index - 1])?.id ?? null };
    }
    case "activate":
      return { ...state, activeId: action.id };
    case "update":
      return {
        ...state,
        tabs: state.tabs.map((tab) => (tab.id === action.id ? { ...tab, ...action.patch } : tab)),
      };
  }
}

/** The tab already showing this URL, if any. */
export const tabForUrl = (state: TabsState, url: string): Tab | null =>
  state.tabs.find((tab) => tab.url === url) ?? null;

/** Whether a link names a web page, which a relative path in a document does not. */
export const isWebLink = (href: string): boolean => /^https?:\/\//i.test(href);

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i;

/** The http(s) URL that text names, or null. Typed text without a scheme is local over http and public over https. */
export function normalizeUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidate = SCHEME.test(trimmed)
    ? trimmed
    : `${LOCAL_HOST.test(trimmed) ? "http" : "https"}://${trimmed}`;
  try {
    const { protocol, href } = new URL(candidate);
    return protocol === "http:" || protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}
