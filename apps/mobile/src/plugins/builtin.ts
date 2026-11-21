import { nativeChatPlugin } from "./builtin/chat";
import { nativeConnectionsPlugin } from "./builtin/connections";
import { nativeDiffPlugin } from "./builtin/diff";
import { nativeFilePreviewPlugin } from "./builtin/file-preview";
import { nativeMarkdownPlugin } from "./builtin/markdown";
import { nativePreviewPlugin } from "./builtin/preview";
import { nativeProjectsPlugin } from "./builtin/projects";
import { nativeProvidersPlugin } from "./builtin/providers";
import { nativePullRequestsPlugin } from "./builtin/pull-requests";
import { nativeSettingsPlugin } from "./builtin/settings";
import { nativeSidebarPlugin } from "./builtin/sidebar";
import { nativeTerminalPlugin } from "./builtin/terminal";
import { nativeThreadPlugin } from "./builtin/thread";
import { nativeUiPlugin } from "./builtin/ui";
import { nativeUsagePlugin } from "./builtin/usage";

/** Executable native entries are compiled by Metro; downloaded entries remain declarative JSON. */
export const builtinNativePlugins = new Map(
  [
    nativeChatPlugin,
    nativeConnectionsPlugin,
    nativeDiffPlugin,
    nativeFilePreviewPlugin,
    nativeMarkdownPlugin,
    nativePreviewPlugin,
    nativeProjectsPlugin,
    nativeProvidersPlugin,
    nativePullRequestsPlugin,
    nativeSettingsPlugin,
    nativeSidebarPlugin,
    nativeTerminalPlugin,
    nativeThreadPlugin,
    nativeUiPlugin,
    nativeUsagePlugin,
  ].map((definition) => [definition.manifest.id, definition] as const),
);
