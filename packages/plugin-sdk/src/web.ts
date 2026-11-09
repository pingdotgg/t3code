import type { ReactNode } from "react";

import type { PluginRpcMap } from "./shared.ts";

type RpcInputArgs<Input> = undefined extends Input ? [input?: Input] : [input: Input];

export type WebPluginNode = ReactNode;

/**
 * Only React's types are needed: build with `@t3tools/plugin-sdk/vite` so the bundle uses T3's
 * React instead of its own copy.
 */
export type WebPluginComponent<Props = Record<string, never>> = (props: Props) => WebPluginNode;

export interface WebPluginRightPanel {
  /** Unique within the plugin. Letters, digits, `_` and `-`. */
  readonly name: string;
  /** Shown on the panel's tab and in the panel's add menu. */
  readonly title: string;
  /** Rendered in the right panel of the thread the user opened it in. */
  readonly component: WebPluginComponent<{ readonly threadId: string }>;
}

export interface WebPluginCommand {
  /**
   * Unique within the plugin: lowercase letters, digits and hyphens. Keybindings name the command
   * `plugin.<pluginId>.<id>`.
   */
  readonly id: string;
  /** Shown in the command palette. */
  readonly title: string;
  /** Extra words the command palette matches. */
  readonly keywords?: ReadonlyArray<string>;
  readonly run: () => void | Promise<void>;
}

/**
 * T3's own parts a plugin can draw its own way with `ui.replace`. Each piece is a React element T3
 * has already wired up: place it, wrap it or leave it out. `original` is T3's own drawing. T3 may
 * add pieces to a part, but never removes or merges one. A change that has to gives the part a new
 * name, and T3 then skips replacements of the old name and draws its own part.
 */
export interface WebPluginParts {
  /**
   * The row under the composer's text box. While no provider is available, `model` offers to open
   * provider settings and `effort` and `access` draw nothing. Only T3's own row folds the controls
   * into a menu as it narrows; pieces placed elsewhere keep their full width.
   */
  readonly "composer.controls": {
    readonly original: WebPluginNode;
    /** The attach button, or null where the composer offers no attachments. */
    readonly attach: WebPluginNode;
    /** T3's grouped model, effort and permissions controls. */
    readonly controls: WebPluginNode;
    /** A picker that only chooses the model. */
    readonly model: WebPluginNode;
    /** The reasoning effort picker; draws nothing when the model has no options. */
    readonly effort: WebPluginNode;
    /** The permissions picker, always labelled, and the plan toggle when plan mode is on. */
    readonly access: WebPluginNode;
    /** Send, stop and the other primary actions. */
    readonly actions: WebPluginNode;
  };
  /** The frame Settings and Usage open in. T3 draws a large window over the thread. */
  readonly "app.pageFrame": {
    readonly original: WebPluginNode;
    /**
     * The page itself, with its section list, header and close button. Its close button closes
     * the page; Esc is up to the frame the plugin draws.
     */
    readonly content: WebPluginNode;
    /**
     * The page in place of the thread, beside the sidebar, without its section list: draw `nav`
     * here, or `app.sidebar`'s `nav` in the sidebar. Esc goes back. Its header is the window's
     * title bar row, with room for the window controls, and its close button hides while the
     * sidebar beside it shows `app.sidebar`'s `back`.
     */
    readonly page: WebPluginNode;
    /** The page's section list, such as Settings' sections and search; null when it has none. */
    readonly nav: WebPluginNode;
    /** Which page this is. Compare this, not `label`, which is text for people. */
    readonly kind: "settings" | "usage";
    /** The page's name as shown, such as `Settings`. */
    readonly label: string;
    /** Goes back to where the page was opened. */
    readonly close: () => void;
  };
  /**
   * The sidebar's content, on wide screens and in the phone's sheet. To give a page shown through
   * `app.pageFrame`'s `page` its own sidebar, draw `nav` in place of `threads` and `back` in place
   * of `footer`.
   */
  readonly "app.sidebar": {
    readonly original: WebPluginNode;
    /** The top row: the T3 Code name, back and forward buttons, and the toggle on phones. */
    readonly header: WebPluginNode;
    /** The thread list with its search row. */
    readonly threads: WebPluginNode;
    /** The bottom row: the Settings, Pull requests and Usage buttons, and T3's update button. */
    readonly footer: WebPluginNode;
    /** `footer` with a Back button in place of its Settings, Pull requests and Usage buttons. */
    readonly back: WebPluginNode;
    /** T3's update button and update notices alone; `footer` and `back` already have them. */
    readonly update: WebPluginNode;
    /** The open page's section list, made for the sidebar, while `page` is `settings`; else null. */
    readonly nav: WebPluginNode;
    /** The page shown through `app.pageFrame`'s `page` beside the sidebar, otherwise null. */
    readonly page: "settings" | "usage" | null;
  };
}

/**
 * What a web plugin's `activate` receives. Everything is released when the plugin unloads. `Rpc`
 * types the calls into the plugin's server half.
 */
export interface WebPluginApi<Rpc extends PluginRpcMap = PluginRpcMap> {
  /**
   * The web API's version, a separate number from the server half's `api.version`. T3 raises it
   * when `WebPluginApi` gains a member, whose doc then names the version that added it, so a plugin
   * can check it before using a member an older T3 lacks. To refuse older T3 releases outright, set
   * `engines.t3` in the manifest.
   */
  readonly version: number;
  readonly id: string;
  /** The environment whose server this plugin was loaded from. */
  readonly environmentId: string;
  readonly rpc: {
    /**
     * Calls a method the plugin's server half registered. A failure rejects with the server's
     * reason, such as the message the handler threw.
     */
    readonly invoke: <Method extends Extract<keyof Rpc["methods"], string>>(
      method: Method,
      ...input: RpcInputArgs<Rpc["methods"][Method]["input"]>
    ) => Promise<Rpc["methods"][Method]["output"]>;
    /** Follows a channel the plugin's server half publishes to; returns the unsubscribe function. */
    readonly subscribe: <Channel extends Extract<keyof Rpc["channels"], string>>(
      channel: Channel,
      onValue: (value: Rpc["channels"][Channel]) => void,
    ) => () => void;
  };
  readonly rightPanel: {
    readonly register: (panel: WebPluginRightPanel) => void;
  };
  readonly settings: {
    /**
     * Shows on the Plugins page in place of the generated settings form, in browsers that load
     * plugin UI from this plugin's environment. Other browsers show the generated form, if the
     * `settingsSchema` has fields.
     */
    readonly registerPanel: (component: WebPluginComponent) => void;
  };
  readonly commands: {
    /**
     * Adds a command to the command palette that users can also bind to a key. When the app loads
     * plugin UI from several environments with this plugin on, only the first of them adds them.
     */
    readonly register: (command: WebPluginCommand) => void;
  };
  readonly ui: {
    /**
     * Draws one of T3's parts until the plugin unloads. When several plugins replace the same
     * part, the one whose id sorts first wins, and the others' rows in Settings say so. A part this
     * T3 doesn't have is skipped with a note on the row. If the component throws, T3 draws its own
     * part. A plugin on in several environments draws from the first. Added in version 2.
     */
    readonly replace: <Part extends keyof WebPluginParts>(
      part: Part,
      component: WebPluginComponent<WebPluginParts[Part]>,
    ) => void;
  };
  readonly composer: {
    /**
     * While on, the composer on wide screens folds to one line, as on phones, when the user scrolls
     * the timeline up. A restored position, a jump or keyboard paging doesn't fold it. Focusing it
     * or scrolling back to the end unfolds it. Added in version 2.
     */
    readonly setCollapseOnScroll: (enabled: boolean) => void;
  };
  /**
   * A URL for a file in the plugin's `assets/` folder, such as `icon.svg`, usable in `src` and
   * `href`. It stays valid until the plugin unloads.
   */
  readonly assetUrl: (name: string) => Promise<string>;
  /**
   * Adds a stylesheet until the plugin unloads. Rules that reach T3's own elements restyle the app
   * and can stop matching when T3 changes its markup. Like commands, it applies from one
   * environment only.
   */
  readonly injectStyles: (css: string) => void;
  /** Opens a path in the app, such as `/settings/plugins`. */
  readonly navigate: (path: string) => void;
  readonly toast: (message: {
    readonly title: string;
    readonly description?: string;
    readonly type?: "info" | "success" | "warning" | "error";
  }) => void;
  /** Runs when the plugin is disabled, reloaded or unloaded. */
  readonly onDeactivate: (cleanup: () => void) => void;
}

export interface WebPluginDefinition<Rpc extends PluginRpcMap = PluginRpcMap> {
  readonly activate: (api: WebPluginApi<Rpc>) => void | Promise<void>;
}

export const HOST_ATOM_REACT_EXPORTS = [
  "RegistryContext",
  "useAtomMount",
  "useAtomRefresh",
  "useAtomSet",
  "useAtomSubscribe",
  "useAtomValue",
] as const;

export const HOST_ATOM_EXPORTS = [
  "family",
  "keepAlive",
  "make",
  "map",
  "readable",
  "setIdleTTL",
  "transform",
  "withLabel",
  "writable",
] as const;

export const HOST_UI_EXPORTS = [
  "Badge",
  "Button",
  "Empty",
  "EmptyContent",
  "EmptyDescription",
  "EmptyHeader",
  "EmptyMedia",
  "EmptyTitle",
  "Input",
  "Label",
  "Switch",
  "Textarea",
] as const;

/**
 * CSS variables T3 defines under every theme and keeps across releases. Themes set them, so a
 * plugin's own styles that use them, such as `var(--border)`, follow the user's theme.
 */
export const THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--ring",
  "--destructive",
  "--destructive-foreground",
  "--warning",
  "--warning-foreground",
  "--success",
  "--success-foreground",
  "--info",
  "--info-foreground",
  "--radius",
  "--terminal-background",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/**
 * Types a web plugin. The ESM bundle's default export is the result. Pass the plugin's
 * `PluginRpcMap`, as in `defineWebPlugin<NotesRpc>({ ... })`, to type `api.rpc`.
 */
export const defineWebPlugin = <Rpc extends PluginRpcMap = PluginRpcMap>(
  definition: WebPluginDefinition<Rpc>,
): WebPluginDefinition<Rpc> => definition;
