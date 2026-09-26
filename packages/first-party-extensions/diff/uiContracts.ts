/**
 * `t3.ui/*` adoption for the Diff panel: theme tokens, the keybinding
 * registration pair, and the panels ops behind the toggle. Everything here
 * degrades honestly — a missing grant or a host without the client-provider
 * seam leaves the panel working on its static fallbacks, and a toggle that
 * cannot reach `t3.ui/panels` is never offered, or withdraws itself once
 * access is confirmed gone.
 *
 * The `t3.ui` contract halves consumed: theme, keybindings, notifications,
 * panels. The native `diff.toggle` binding is
 * `mod+d` with `!terminalFocus` (packages/shared/src/keybindings.ts). The
 * native panel surfaces no toasts, so `t3.ui/notifications` is used only to
 * report command-dispatch failures — a failure path the native toggle cannot
 * have; the panel's inline status rows already match native rendering.
 */
import {
  uiKeybindingsApi,
  uiNotificationsApi,
  uiPanelsApi,
  uiThemeApi,
} from "@t3tools/extension-sdk/catalogue";
import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type { ClientHost, GlobalCommandDescriptor } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";

export const DIFF_SURFACE_ID = "t3.diff/view";
export const DIFF_TOGGLE_COMMAND_ID = "toggle";

/** Resolved `t3.ui/theme` role values; null when the contract is unavailable. */
export type ThemeTokens = Readonly<Record<string, string>>;

/**
 * A `var(--host-name, fallback)` reference whose fallback is the contract's
 * resolved token when `t3.ui/theme` is available, else the static value the
 * panel always carried. The host variable wins whenever the host defines it;
 * the token keeps the fallback truthful — getTokens resolves stored
 * preferences, the session overlay, and external previews — instead of a
 * hardcoded guess.
 */
export function themeVar(
  tokens: ThemeTokens | null,
  name: string,
  role: string,
  fallback: string,
): string {
  return `var(${name}, ${tokens?.[role] ?? fallback})`;
}

/**
 * The panel's themed values and shared style objects, rebuilt when the
 * contract tokens change. Roles mirror the host's own mapping
 * (`--border` → `border`, `--muted-foreground` → `mutedForeground`,
 * `--background` → `canvas`, `--accent` → `accentSurface`,
 * `--destructive` → `error`, `--muted` → `muted`, `--foreground` → `text`,
 * `--ring` → `focus`). `--success` and the font stacks have no theme role —
 * they stay as they were.
 */
export function panelTheme(tokens: ThemeTokens | null) {
  const muted = themeVar(tokens, "--muted-foreground", "mutedForeground", "#667085");
  const border = themeVar(tokens, "--border", "border", "#dfe3e8");
  const accent = themeVar(tokens, "--accent", "accentSurface", "#e8eef7");
  const accentOutline = themeVar(tokens, "--accent", "accentSurface", "#b7cff0");
  const destructive = themeVar(tokens, "--destructive", "error", "#cf222e");
  const background = themeVar(tokens, "--background", "canvas", "#fff");
  const focusRing = themeVar(tokens, "--ring", "focus", "#1b4ed8");
  const foreground = themeVar(tokens, "--foreground", "text", "#20252d");
  const mutedSurface = themeVar(tokens, "--muted", "muted", "#f4f5f7");
  const control = {
    padding: "4px 8px",
    border: `1px solid ${border}`,
    borderRadius: 5,
    background: "transparent",
    color: "inherit",
    font: "inherit",
    fontSize: 12,
    cursor: "pointer",
  } as const;
  const rowBase = {
    display: "flex",
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: 11,
    lineHeight: "18px",
    whiteSpace: "pre",
  } as const;
  const gutter = {
    width: 40,
    flexShrink: 0,
    textAlign: "right" as const,
    paddingRight: 8,
    color: muted,
    userSelect: "none" as const,
  };
  const iconButton = {
    ...control,
    padding: "2px 6px",
    fontSize: 11,
  } as const;
  return {
    control,
    rowBase,
    gutter,
    iconButton,
    muted,
    border,
    accent,
    accentOutline,
    destructive,
    background,
    focusRing,
    foreground,
    mutedSurface,
  };
}

/**
 * The installation-scoped set, staged at factory time via
 * `ClientHost.registerGlobalCommands`. `mod+d` mirrors the native
 * `diff.toggle` rule; user and native rules outrank plugin defaults, so the
 * binding only claims the key when nothing else does — `listConflicts`
 * reports the loss honestly. `activation` is the cold-open fallback for a
 * closed surface; the staged handler supplies real toggle semantics.
 */
export const DIFF_TOGGLE_GLOBAL_COMMANDS: readonly GlobalCommandDescriptor[] = [
  {
    id: DIFF_TOGGLE_COMMAND_ID,
    title: "Toggle Diff",
    description: "Show or hide the diff panel",
    defaultKey: "mod+d",
    when: "!terminalFocus",
    scope: "global",
    activation: { surfaceId: DIFF_SURFACE_ID, placement: "side-panel" },
  },
];

/**
 * The view-scoped set a mounted diff view registers — same command id, never
 * `activation`. Scope `thread` narrows the focused-view tier to bindings
 * whose context thread is the active one.
 */
export const DIFF_TOGGLE_VIEW_COMMANDS: readonly GlobalCommandDescriptor[] = [
  {
    id: DIFF_TOGGLE_COMMAND_ID,
    title: "Toggle Diff",
    description: "Hide the diff panel",
    scope: "thread",
  },
];

export type DiffSurfaceAction = "open" | "activate" | "close";

/** `unavailable`: the panels capability is missing or revoked — not an operation failure. */
export type DiffToggleOutcome = DiffSurfaceAction | "unavailable" | null;

/**
 * The ops `toggle` drives. `getCapabilities` is grant-free and reports
 * provider reachability; grant state is enforced per-invoke by the broker
 * (`API capability denied: <grant>`), so a denied or revoked `t3.ui/panels`
 * surfaces as an invoke error even when every op reports reachable —
 * `PANEL_ACCESS_DENIED` recognizes that specific denial as permanent.
 */
const PANEL_TOGGLE_OPERATIONS = [
  "listSurfaces",
  "openSurface",
  "activateSurface",
  "closeSurface",
] as const;

const PANEL_ACCESS_DENIED = /capability denied: t3\.ui\/panels/;

/**
 * Toggle decision over a `listSurfaces` result: absent opens the surface, a
 * backgrounded tab activates it, and the active tab closes — the contract has
 * no panel-hide op for side-panel surfaces, so removing the tab is the honest
 * "toggle off".
 */
export function diffToggleAction(
  surfaces: readonly { readonly id: string; readonly active: boolean }[],
): DiffSurfaceAction {
  const existing = surfaces.find((surface) => surface.id === DIFF_SURFACE_ID);
  if (existing === undefined) return "open";
  return existing.active ? "close" : "activate";
}

/**
 * The toggle body shared by the installation-level dispatch handler and a
 * focused view's binding. The detached deadline is deliberate: closing the
 * surface disposes the calling view, and its session signal must not race
 * the panels write.
 */
export async function toggleDiffSurface(
  host: ClientHost,
  context: ViewContext,
): Promise<DiffToggleOutcome> {
  const threadId = context.resource.threadId;
  if (threadId === undefined) return null;
  const signal = AbortSignal.timeout(10_000);
  const api = bindApi(uiPanelsApi, host, context);
  try {
    const capabilities = await api.invoke("getCapabilities", {}, signal);
    if (
      !PANEL_TOGGLE_OPERATIONS.every((operation) => capabilities.operations?.[operation] === true)
    )
      return "unavailable";
    const { surfaces } = await api.invoke("listSurfaces", { threadId }, signal);
    const action = diffToggleAction(surfaces);
    if (action === "open") {
      await api.invoke(
        "openSurface",
        { surfaceId: DIFF_SURFACE_ID, placement: "side-panel", threadId },
        signal,
      );
    } else if (action === "activate") {
      await api.invoke("activateSurface", { surfaceId: DIFF_SURFACE_ID, threadId }, signal);
    } else {
      await api.invoke("closeSurface", { surfaceId: DIFF_SURFACE_ID, threadId }, signal);
    }
    return action;
  } catch (error) {
    if (error instanceof Error && PANEL_ACCESS_DENIED.test(error.message)) return "unavailable";
    throw error;
  }
}

/**
 * A rejected toggle (revoked grant, dead connection, raced surface list) is
 * surfaced through `t3.ui/notifications` — the keybinding has no in-panel
 * affordance, so the toast is the honest failure channel — with a console
 * record as the last resort when notifications themselves are unavailable.
 * This is the only notification the panel sends: inline statuses stay inline,
 * matching the native panel.
 */
const reportToggleFailure = (host: ClientHost, context: ViewContext, error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  const threadId = context.resource.threadId;
  void bindApi(uiNotificationsApi, host, context)
    .invoke(
      "notify",
      {
        severity: "error",
        title: "Could not toggle the diff panel",
        body: detail.slice(0, 500),
        dismissible: true,
        durationMs: 8_000,
        ...(threadId ? { threadId, anchor: "thread" as const } : { anchor: "global" as const }),
      },
      AbortSignal.timeout(10_000),
    )
    .catch(() => {
      console.warn(`t3.diff/${DIFF_TOGGLE_COMMAND_ID} dispatch failed:`, error);
    });
};

/** Same channel as `reportToggleFailure`, for access loss rather than op failure. */
const reportToggleUnavailable = (host: ClientHost, context: ViewContext) => {
  const threadId = context.resource.threadId;
  void bindApi(uiNotificationsApi, host, context)
    .invoke(
      "notify",
      {
        severity: "error",
        title: "The diff panel toggle is unavailable",
        body: "The t3.ui/panels capability is not granted or its provider is gone; the toggle command has been withdrawn.",
        dismissible: true,
        durationMs: 8_000,
        ...(threadId ? { threadId, anchor: "thread" as const } : { anchor: "global" as const }),
      },
      AbortSignal.timeout(10_000),
    )
    .catch(() => {
      console.warn(`t3.diff/${DIFF_TOGGLE_COMMAND_ID} is unavailable: t3.ui/panels access lost`);
    });
};

/**
 * Shared dispatch for both registration paths. "unavailable" means the
 * panels capability is gone — the command must not keep looking runnable:
 * withdraw the owning set so the palette drops it, and say why. Withdrawal
 * never waits on the notification channel.
 */
const dispatchToggle = (
  host: ClientHost,
  context: ViewContext,
  commandSetToken: string | undefined,
) => {
  void toggleDiffSurface(host, context)
    .then(async (result) => {
      if (result !== "unavailable") return;
      reportToggleUnavailable(host, context);
      if (commandSetToken === undefined) return;
      await bindApi(uiKeybindingsApi, host, context)
        .invoke("unregisterCommands", { commandSetToken }, AbortSignal.timeout(10_000))
        .catch(() => {});
    })
    .catch((error) => reportToggleFailure(host, context, error));
};

/**
 * Factory-time staging of the installation-scoped toggle. Absent on hosts
 * without the seam — nothing registers, dispatch and palette simply never
 * see the command. The host registry also rejects the set at commit when the
 * installation lacks `t3.ui/panels`; a post-commit grant revocation is
 * caught at dispatch, which withdraws the committed set.
 */
export function stageDiffCommands(host: ClientHost): void {
  const handle = host.registerGlobalCommands?.(
    DIFF_TOGGLE_GLOBAL_COMMANDS,
    ({ commandId, context }) => {
      if (commandId !== DIFF_TOGGLE_COMMAND_ID) return;
      dispatchToggle(host, context, handle?.token);
    },
  );
}

/**
 * The mounted view's half of `t3.ui/keybindings`: a grant-enforced
 * `listSurfaces` read gates registration — `getCapabilities` is grant-free
 * and reports provider reachability, so denied `t3.ui/panels` access must
 * be proven against a protected op, not the caps map. A view whose toggle
 * cannot run never offers the command — then register the view-scoped set
 * and bind the view-local
 * handler so the focused-view dispatch tier closes the panel directly. A
 * rejected registration or a host without a binding store leaves the
 * installation tier as the only path; disposal unregisters the view's set.
 */
export function bindDiffViewCommands(host: ClientHost, session: ViewSession): void {
  const threadId = session.context.resource.threadId;
  if (threadId === undefined) return;
  const keybindings = bindApi(uiKeybindingsApi, host, session.context);
  const panels = bindApi(uiPanelsApi, host, session.context);
  void panels.invoke("listSurfaces", { threadId }, session.signal).then(
    () => {
      if (session.signal.aborted) return;
      void keybindings
        .invoke("registerCommands", { commands: DIFF_TOGGLE_VIEW_COMMANDS }, session.signal)
        .then(
          ({ commandSetToken, results }) => {
            if (session.signal.aborted) return;
            session.onDispose(() => {
              void keybindings
                .invoke("unregisterCommands", { commandSetToken }, AbortSignal.timeout(10_000))
                .catch(() => {});
            });
            if (!results.every((result) => result.status === "registered")) return;
            try {
              session.bindCommands(commandSetToken, ({ commandId, context }) => {
                if (commandId !== DIFF_TOGGLE_COMMAND_ID) return;
                dispatchToggle(host, context, commandSetToken);
              });
            } catch {
              // No binding store on this host — dispatch stays on the
              // installation-level handler staged at factory time.
            }
          },
          () => {},
        );
    },
    () => {},
  );
}

/**
 * `t3.ui/theme` consumption: one `getTokens` read plus a `subscribeState`
 * stream whose events re-resolve tokens — stored preference writes, session
 * overlays, and external/editor previews all surface through the stream.
 *
 * Two fences keep the paint honest. The `latest` sequence orders reads: only
 * the most recently issued one may publish or clear. The `alive` flag is the
 * generation fence: the pump polls the stream without awaiting reads, so a
 * dead subscription is observed immediately and any read still in flight
 * resolves into a dead generation — it can never publish late tokens. A
 * failed latest read and a lost subscription both clear the overrides to the
 * static fallbacks. Caller owns the signal; aborting suppresses every
 * publish.
 */
export function watchThemeTokens(
  host: ClientHost,
  context: ViewContext,
  signal: AbortSignal,
  onTokens: (tokens: ThemeTokens | null) => void,
): void {
  const api = bindApi(uiThemeApi, host, context);
  let alive = true;
  let latest = 0;
  const refresh = () => {
    const seq = ++latest;
    return api.invoke("getTokens", {}, signal).then(
      (result) => {
        if (!signal.aborted && alive && seq === latest) onTokens(result.tokens);
      },
      () => {
        if (!signal.aborted && seq === latest) onTokens(null);
      },
    );
  };
  const markDead = () => {
    alive = false;
    latest += 1;
    if (!signal.aborted) onTokens(null);
  };
  void refresh();
  void (async () => {
    const stream = bindStreamApi<{
      subscribeState: { input: Record<string, never>; event: Json };
    }>(uiThemeApi, host, context).subscribe("subscribeState", {}, signal);
    for await (const frame of stream) {
      if (signal.aborted || frame.type === "closed") break;
      // Deliberately unawaited: the pump keeps polling next() so stream death
      // is observed even while a token read is still in flight.
      void refresh();
    }
    markDead();
  })().catch(markDead);
}
