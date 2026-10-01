import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import {
  FILE_LINK_REVEAL_UNSAFE_CSS,
  SOURCE_PREVIEW_VIRTUALIZER_CONFIG,
} from "./fileSurfaceChrome";

/**
 * Highlighted source for files that cannot be edited: captured attachments,
 * host files outside the workspace and truncated reads. Same surface theme,
 * word-wrap preference and virtualization as the editable workspace file.
 * `wordWrap` overrides the preference for callers that own their own toggle.
 */
export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly wordWrap?: boolean;
  readonly onPostRender?: FileOptions<unknown>["onPostRender"];
}) {
  const { resolvedTheme } = useTheme();
  const preferredWordWrap = useClientSettings((settings) => settings.wordWrap);
  const wordWrap = props.wordWrap ?? preferredWordWrap;
  return (
    <DiffWorkerPoolProvider>
      <Virtualizer
        key={`${props.name}:${resolvedTheme}:${props.text.length}`}
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={SOURCE_PREVIEW_VIRTUALIZER_CONFIG}
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
            unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
            ...(props.onPostRender ? { onPostRender: props.onPostRender } : {}),
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </DiffWorkerPoolProvider>
  );
}
