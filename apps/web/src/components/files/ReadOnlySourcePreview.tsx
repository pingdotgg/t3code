import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useEditorConfigTabWidths } from "~/hooks/useEditorConfigTabWidths";
import { DEFAULT_TAB_WIDTH } from "~/lib/editorConfig";
import { CODE_WHITESPACE_UNSAFE_CSS, renderCodeWhitespace } from "~/lib/codeWhitespace";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";

/**
 * Highlighted source for files that cannot be edited: captured attachments,
 * host files outside the workspace and truncated reads. Same surface theme,
 * word-wrap preference and virtualization as the editable workspace file.
 */
export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly onPostRender?: FileOptions<unknown>["onPostRender"];
  readonly workspace?: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly revision?: string | null;
  };
}) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const showWhitespace = useClientSettings((settings) => settings.showWhitespaceCharacters);
  const tabWidths = useEditorConfigTabWidths(
    props.workspace?.environmentId ?? null,
    props.workspace?.cwd ?? null,
    [props.name],
    props.workspace?.revision ?? null,
  );
  const tabWidth = tabWidths.get(props.name) ?? DEFAULT_TAB_WIDTH;
  const surfacePostRender = props.onPostRender;
  const onPostRender = useCallback<NonNullable<FileOptions<unknown>["onPostRender"]>>(
    (node, instance, phase) => {
      if (phase !== "unmount") renderCodeWhitespace(node, showWhitespace);
      surfacePostRender?.(node, instance, phase);
    },
    [surfacePostRender, showWhitespace],
  );
  return (
    <DiffWorkerPoolProvider>
      <Virtualizer
        key={`${props.name}:${resolvedTheme}:${props.text.length}`}
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        <File
          file={{
            name: props.name,
            contents: props.text,
            ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
          }}
          options={{
            disableFileHeader: true,
            overflow: wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            themeType: resolvedTheme,
            unsafeCSS: `${FILE_LINK_REVEAL_UNSAFE_CSS}\n${CODE_WHITESPACE_UNSAFE_CSS}\n:host { --diffs-tab-size: ${tabWidth}; }`,
            onPostRender,
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </DiffWorkerPoolProvider>
  );
}
