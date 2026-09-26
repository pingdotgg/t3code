/**
 * `t3.ui/*` contract adoption for the Browser panel — theme token republish,
 * the command sets handed to host keybinding arbitration, and the toggle's
 * open/activate/close decision over `t3.ui/panels`. Everything here is pure
 * or client-injected so the logic is testable without a mounted view.
 */
import type {
  ApiMethodTypes,
  ApiStreamTypes,
  TypedApi,
  TypedApiStreamFrame,
  TypedStreamApi,
} from "@t3tools/extension-sdk/capabilities";
import type { uiNotificationsApi, uiPanelsApi, uiThemeApi } from "@t3tools/extension-sdk/catalogue";
import type { GlobalCommandDescriptor } from "@t3tools/extension-sdk/environment";

/** Full manifest id of the thread-scoped browser surface (`t3.browser` + `view`). */
export const BROWSER_SURFACE_ID = "t3.browser/view";

type BoundInvoke<T extends ApiMethodTypes> = <K extends keyof T & string>(
  method: K,
  input: T[K]["input"],
  signal: AbortSignal,
) => Promise<T[K]["output"]>;

/** The structural shape `bindApi` returns — tests inject a fake client behind it. */
type BoundApi<A> = A extends TypedApi<infer T> ? { invoke: BoundInvoke<T> } : never;

/** The structural shape `bindStreamApi` returns — tests inject a fake client behind it. */
type BoundStreams<A> =
  A extends TypedStreamApi<infer T>
    ? {
        subscribe: <K extends keyof T & string>(
          name: K,
          input: T[K]["input"],
          signal: AbortSignal,
        ) => AsyncIterable<TypedApiStreamFrame<T[K]["event"]>>;
      }
    : never;

// ---------------------------------------------------------------------------
// t3.ui/theme

/**
 * The roles this panel consumes, each republished as a `--t3-browser-*`
 * custom property on the view root. Styles chain `var(--t3-browser-x, …)`
 * ahead of their pre-contract fallbacks, so a host that cannot serve the
 * contract (ungranted or provider-less) renders exactly what it rendered
 * before adoption.
 */
export const BROWSER_THEME_VARS = {
  text: "--t3-browser-text",
  mutedForeground: "--t3-browser-muted-foreground",
  border: "--t3-browser-border",
  canvas: "--t3-browser-canvas",
} as const;

/**
 * `getTokens` output → root-level custom properties. Each override carries
 * the contract's advertised var name with the resolved value as its
 * fallback, so the panel tracks `--app-theme-*` paints live and still gets
 * the right color on hosts that answer the contract without painting those
 * variables. A role missing from `tokens` is skipped rather than overridden
 * with a lie.
 */
export function themeVarOverrides(
  tokens: Readonly<Record<string, string>>,
  cssVars: Readonly<Record<string, string>>,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [role, property] of Object.entries(BROWSER_THEME_VARS)) {
    const value = tokens[role];
    if (value === undefined) continue;
    const contractVar = cssVars[role];
    overrides[property] = contractVar ? `var(${contractVar}, ${value})` : value;
  }
  return overrides;
}

/**
 * The theme-consumption lifecycle, kept free of React so the stale-fallback
 * rule is directly testable. Contract tokens are current exactly while the
 * contract is live: a rejected `getTokens` clears the applied map, and a
 * `closed` or lost `subscribeState` stream both clears it and fences any read
 * still in flight — an obsolete successful read must never republish after
 * the subscription that made it meaningful is gone. `apply(null)` restores
 * the legacy `var()` chain; a later live frame re-reads and republishes.
 */
export function watchThemeVars(
  theme: BoundApi<typeof uiThemeApi>,
  streams: BoundStreams<typeof uiThemeApi>,
  signal: AbortSignal,
  apply: (vars: Record<string, string> | null) => void,
): void {
  let generation = 0;
  let live = true;
  const refresh = () => {
    const at = ++generation;
    void theme.invoke("getTokens", {}, signal).then(
      (value) => {
        if (live && !signal.aborted && at === generation)
          apply(themeVarOverrides(value.tokens, value.cssVars));
      },
      () => {
        if (!signal.aborted && at === generation) apply(null);
      },
    );
  };
  refresh();
  void (async () => {
    try {
      for await (const frame of streams.subscribe("subscribeState", {}, signal)) {
        if (signal.aborted || frame.type === "closed") break;
        refresh();
      }
    } catch {
      // Errored and closed subscriptions land in the same place below.
    }
    live = false;
    generation++;
    if (!signal.aborted) apply(null);
  })();
}

/**
 * `preview.focusUrl` parity: the chord focuses the address field and selects
 * its contents (the native row's onFocus queues `select()`), so the next
 * keystroke replaces the URL rather than editing at the caret.
 */
export function focusAddressInput(
  input: { readonly focus: () => void; readonly select: () => void } | null,
): void {
  input?.focus();
  input?.select();
}

// ---------------------------------------------------------------------------
// t3.ui/keybindings

/**
 * Installation-tier commands, staged through `ClientHost.registerGlobalCommands`
 * at factory time — only that path mints the `t3.extensions`-scoped context
 * that makes `scope:"global"` + `activation` legal. The default key mirrors
 * the native `preview.toggle` chord; user and native rules always win the
 * arbitration, so the declaration is honest even where the native rule
 * shadows it.
 */
export const BROWSER_GLOBAL_COMMANDS: readonly GlobalCommandDescriptor[] = [
  {
    id: "toggle",
    title: "Toggle Browser Panel",
    defaultKey: "mod+shift+j",
    scope: "global",
    activation: { surfaceId: BROWSER_SURFACE_ID, placement: "side-panel" },
  },
];

/**
 * View-local commands, registered per view under the session's thread context
 * so `session.bindCommands` can claim them — a staged installation context
 * can never deep-equal a view context. `when` gates each key on this
 * surface's focus exactly like the native `previewFocus` rules, so a bound
 * chord can never shadow typing or another panel's shortcut.
 */
export const BROWSER_VIEW_COMMANDS: readonly GlobalCommandDescriptor[] = [
  {
    id: "reload",
    title: "Reload Page",
    defaultKey: "mod+r",
    when: `extension.${BROWSER_SURFACE_ID}.focus`,
    scope: "surface",
  },
  {
    id: "focusAddress",
    title: "Focus Address Bar",
    defaultKey: "mod+l",
    when: `extension.${BROWSER_SURFACE_ID}.focus`,
    scope: "surface",
  },
];

// ---------------------------------------------------------------------------
// t3.ui/panels + t3.ui/notifications — the toggle press

export type ToggleOutcome = "opened" | "activated" | "closed";

/**
 * `preview.toggle` parity over `t3.ui/panels`: absent → open, present but
 * inactive → activate, active → close. Every hop goes through the granted
 * seam — a denied or unavailable provider rejects rather than pretending.
 */
export async function togglePanelSurface(
  panels: BoundApi<typeof uiPanelsApi>,
  threadId: string,
  signal: AbortSignal,
): Promise<ToggleOutcome> {
  const { surfaces } = await panels.invoke("listSurfaces", { threadId }, signal);
  const open = surfaces.find((surface) => surface.id === BROWSER_SURFACE_ID);
  if (!open) {
    await panels.invoke(
      "openSurface",
      { surfaceId: BROWSER_SURFACE_ID, placement: "side-panel", threadId },
      signal,
    );
    return "opened";
  }
  if (open.active) {
    await panels.invoke("closeSurface", { surfaceId: open.id, threadId }, signal);
    return "closed";
  }
  await panels.invoke("activateSurface", { surfaceId: open.id, threadId }, signal);
  return "activated";
}

/**
 * The panel's one toast: a toggle press that cannot act. Matches the native
 * `preview.toggle` "desktop-only" notice — transient status inside the panel
 * (navigation failures, ended sessions) stays inline like the native
 * unreachable view, so nothing else routes here.
 */
export async function notifyToggleFailure(
  notifications: BoundApi<typeof uiNotificationsApi>,
  threadId: string,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  await notifications.invoke(
    "notify",
    {
      severity: "error",
      title: "Unable to toggle the browser panel",
      ...(error instanceof Error ? { body: error.message } : {}),
      threadId,
      anchor: "thread",
    },
    signal,
  );
}
