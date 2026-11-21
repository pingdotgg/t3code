import type { ClientPluginSdk } from "./PluginHost";
import { activate as activateCanvas } from "./builtin/canvas";
import { activate as activateChat } from "./builtin/chat";
import { activate as activateThread } from "./builtin/thread";
import { activate as activateSidebar } from "./builtin/sidebar";
import { activate as activateMarkdown } from "./builtin/markdown";
import { activate as activateDiff } from "./builtin/diff";
import { activate as activatePreview } from "./builtin/preview";
import { activate as activateFilePreview } from "./builtin/file-preview";
import { activate as activatePullRequests } from "./builtin/pull-requests";
import { activate as activateUsage } from "./builtin/usage";
import { activate as activateSettings } from "./builtin/settings";
import { activate as activateConnections } from "./builtin/connections";
import { activate as activateProviders } from "./builtin/providers";
import { activate as activateUi } from "./builtin/ui";

/** Compiled client modules use SDK staging without executing server-served JavaScript. */
export const builtinClientPlugins = new Map<
  string,
  { readonly activate: (sdk: ClientPluginSdk) => void | Promise<void> }
>([
  ["t3.canvas", { activate: activateCanvas }],
  ["t3.chat", { activate: activateChat }],
  ["t3.thread", { activate: activateThread }],
  ["t3.sidebar", { activate: activateSidebar }],
  ["t3.markdown", { activate: activateMarkdown }],
  ["t3.diff", { activate: activateDiff }],
  ["t3.preview", { activate: activatePreview }],
  ["t3.file-preview", { activate: activateFilePreview }],
  ["t3.pull-requests", { activate: activatePullRequests }],
  ["t3.usage", { activate: activateUsage }],
  ["t3.settings", { activate: activateSettings }],
  ["t3.connections", { activate: activateConnections }],
  ["t3.providers", { activate: activateProviders }],
  ["t3.ui", { activate: activateUi }],
]);
