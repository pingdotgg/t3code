import { buildFileLinkParentSuffixByPath, fileLinkLabel } from "@t3tools/shared/fileLinks";
import {
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
} from "@t3tools/shared/markdownLinks";
import { isHostPath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  SOURCE_CONTROL_MEDIA_ASSET,
} from "@t3tools/contracts";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { useAtomValue } from "@effect/atom-react";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  FileSpreadsheetIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  LightbulbIcon,
  MailIcon,
  MessageSquareIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  PresentationIcon,
  SparklesIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import {
  AssetWorkspaceAssetNotFoundError,
  AuthPreviewOperateScope,
  type EditorId,
  type EnvironmentId,
  type ServerConfig,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
  type CodexArtifactTemplateKind,
} from "@t3tools/shared/codexArtifactTemplates";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { mediaKindFromPath, mediaMimeTypeFromExtension } from "@t3tools/shared/mediaPreview";
import { InlineAudioPreview } from "./files/InlineAudioPreview";
import { HostImageUrlContext } from "./chat/hostImageUrl";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import React, {
  Suspense,
  type ComponentProps,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
  use,
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Components,
  ExtraProps as ReactMarkdownExtraProps,
  Options as ReactMarkdownOptions,
} from "react-markdown";
import { createIncrementalMarkdownPlugin } from "../markdown-incremental";
import type { Pluggable, PluggableList } from "unified";
import { defaultUrlTransform } from "react-markdown";
import { parseAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { AssistantCitationChip } from "./chat/AssistantCitationChip";
import { MarkdownThreadLink } from "./chat/MarkdownThreadLink";
import { mathKind } from "@t3tools/shared/markdownMath";
import remarkMath from "remark-math";
import {
  artifactTemplateFromHastProperties,
  renderCodexInlineDirectivesAsMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import { MarkdownMath } from "./chat/MarkdownMath";
import {
  resolveMarkdownMediaPreview,
  type ExpandedImagePreview,
} from "./chat/ExpandedImagePreview";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { markdownImageGallery } from "./chat/markdownImageGallery";
import { type MediaActionSource } from "./media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "./media/mediaContent";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "./preview/fileExplorerLabel";
import {
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from "./chat/externalLinkContextMenu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { recordVisitForThread } from "../browserHistoryStore";
import {
  PreferredEditorEnvironmentRequiredError,
  useOpenInPreferredEditor,
  usePreferredEditor,
} from "../editorPreferences";
import { openInEditorMenuLabel } from "../editorLabels";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { useRenderedAppearance } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "../markdownFileHostPath";
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { resolveRemoteOpenState, useRemoteOpenResolution } from "../remoteOpen";
import { useRightPanelStore } from "../rightPanelStore";
import { readThreadShell, useProjects } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import { assetEnvironment } from "../state/assets";
import {
  readEnvironmentScope,
  readPreparedConnection,
  useEnvironmentScope,
} from "../state/session";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { projectEnvironment } from "../state/projects";
import { filesystemEnvironment } from "../state/filesystem";
import {
  claimWorkspaceBasenameLookup,
  needsWorkspaceBasenameLookup,
  pickStrippedWorkspaceMatch,
  pickWorkspaceBasenameMatch,
  stripRepeatedWorkspacePrefix,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import { resolvePullRequestPreviewTarget } from "@t3tools/client-runtime/change-request-links";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { useOpenLink } from "../browser/useOpenLink";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import {
  isBrowserPreviewFile,
  openFileInPreview,
  openUrlInPreview,
  BrowserPreviewUnavailableError,
  BrowserSettingsReadError,
} from "../browser/openFileInPreview";
import { resolveLinkTarget } from "../browser/browserLinkTarget";
import { PullRequestLinkPreview } from "./pullRequest/PullRequestLinkPreview";
import { MarkdownCodeBlock, SuspenseShikiCodeBlock } from "./chat/MarkdownCodeBlock";
import { createMarkdownRenderer } from "./chat/markdownRenderer";
import { splitMarkdownBlocks } from "./chat/markdownStreamBlocks";
import { MarkdownMermaidCodeBlock } from "./chat/MarkdownMermaidCodeBlock";
import { MarkdownTable } from "./chat/MarkdownTable";
import { MarkdownDetails } from "./chat/MarkdownDetails";
import {
  authoredImageSizeStyle,
  ChatMarkdownAssetImage,
  ChatMarkdownImage,
  ChatMarkdownImageFallback,
  ChatMarkdownVideo,
  MarkdownLinkContext,
  markdownImageCopy,
} from "./chat/ChatMarkdownMedia";
import { MarkdownExternalLinkContent } from "./chat/MarkdownExternalLink";
import { MarkdownFileLink } from "./chat/MarkdownFileLink";
import { canUseMarkdownFileShellActions } from "./chat/MarkdownFileLink.logic";
import { rehypeChipPunctuation } from "./chat/markdownChipPunctuation";
import { handleMarkdownFragmentClick, rehypeHeadingIds } from "./chat/markdownFragments";
import { rehypeTextDirection } from "./chat/markdownTextDirection";
import { hastHasText, hastPlainTextDeep, plainHastText } from "./chat/markdownHast.logic";
import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  isClosedCodeFence,
  nodeToPlainText,
} from "./chat/MarkdownCodeBlock.logic";
import { reportMarkdownActionFailure } from "./chat/markdownActionFailure";
import { useChatMarkdownState } from "./ChatMarkdownParts";

export const isAssetNotFoundError = Schema.is(AssetWorkspaceAssetNotFoundError);

export interface ChatMarkdownProps {
  /** Compact markdown transforms remove blocks before rendering inside a label. */
  inline?: boolean;
  text: string;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  pullRequestPanelRef?: ScopedThreadRef | undefined;
  environmentId?: EnvironmentId | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<ServerProviderSkill>;
  className?: string;
  lineBreaks?: boolean;
  parseRawHtml?: boolean;
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  onRunShellCommand?: ((command: string) => void) | undefined;
  imageBaseDir?: string | undefined;
  workspaceMutationId?: string | null | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  /** Keep one list per configuration (a module constant): it keys the shared parse cache. */
  extraRemarkPlugins?: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  /** Loads media a source control host keeps behind a credential through the server, which holds
      `cwd`'s; without it a private repository's uploads load unauthenticated and 404. */
  sourceControlMedia?: boolean | undefined;
  headingLevelOffset?: number | undefined;
}

export interface ChatMarkdownContextReference {
  kind: string;
  contextId: string;
  label: string;
}

export const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const EMPTY_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [];

export {
  fileLinkSourcesKey,
  markdownServerConfigFieldsAtom,
  resolveFileLinkSources,
  CHAT_MARKDOWN_COMPONENTS,
  CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS,
  CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS,
  ChatMarkdownRendererContext,
  ChatMarkdownTextContext,
  markdownUrlTransform,
} from "./ChatMarkdownComponents";

import {
  CHAT_MARKDOWN_COMPONENTS,
  CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS,
  CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS,
  ChatMarkdownRendererContext,
  ChatMarkdownTextContext,
  markdownUrlTransform,
} from "./ChatMarkdownComponents";

const REMARK_MATH: Pluggable = [remarkMath, { singleDollarTextMath: true }];
// Shared lists, so every message with the same options shares a processor and its cache.
const CHAT_MARKDOWN_REMARK_PLUGIN_SETS = {
  plain: CHAT_MARKDOWN_REMARK_PLUGINS,
  breaks: CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  math: [REMARK_MATH, ...CHAT_MARKDOWN_REMARK_PLUGINS],
  mathBreaks: [REMARK_MATH, ...CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS],
} satisfies Record<string, PluggableList>;

const combinedPlugins = new WeakMap<PluggableList, WeakMap<PluggableList, PluggableList>>();

// One combined list per pair, so a stable extra list shares a renderer and its parse cache.
function withExtraPlugins(shared: PluggableList, extra: PluggableList): PluggableList {
  if (extra.length === 0) return shared;
  let byShared = combinedPlugins.get(extra);
  if (!byShared) combinedPlugins.set(extra, (byShared = new WeakMap()));
  let combined = byShared.get(shared);
  if (!combined) byShared.set(shared, (combined = [...shared, ...extra]));
  return combined;
}

const markdownRenderers = new WeakMap<
  PluggableList,
  WeakMap<PluggableList, ReturnType<typeof createMarkdownRenderer>>
>();

function markdownRenderer(remarkPlugins: PluggableList, rehypePlugins: PluggableList) {
  let byRehype = markdownRenderers.get(remarkPlugins);
  if (!byRehype) markdownRenderers.set(remarkPlugins, (byRehype = new WeakMap()));
  let renderer = byRehype.get(rehypePlugins);
  if (!renderer) {
    renderer = createMarkdownRenderer({
      remarkPlugins,
      rehypePlugins,
      components: CHAT_MARKDOWN_COMPONENTS,
      urlTransform: markdownUrlTransform,
    });
    byRehype.set(rehypePlugins, renderer);
  }
  return renderer;
}

const MarkdownSource = memo(function MarkdownSource({
  text,
  remarkPlugins,
  rehypePlugins,
  shared,
  cache,
}: {
  text: string;
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
  /** The plugins are one of the shared sets. */
  shared: boolean;
  /** The text will not change again; streamed text would only fill the cache with prefixes. */
  cache: boolean;
}) {
  // Per-instance plugins, such as the incremental parser, set up their state on every render.
  const render = shared
    ? markdownRenderer(remarkPlugins, rehypePlugins)
    : createMarkdownRenderer({
        remarkPlugins,
        rehypePlugins,
        components: CHAT_MARKDOWN_COMPONENTS,
        urlTransform: markdownUrlTransform,
      });
  return (
    <ChatMarkdownTextContext value={text}>{render(text, shared && cache)}</ChatMarkdownTextContext>
  );
});

function ChatMarkdown({
  text,
  className,
  inline = false,
  lineBreaks = false,
  parseRawHtml = true,
  extraRemarkPlugins = EMPTY_REMARK_PLUGINS,
  ...props
}: ChatMarkdownProps) {
  const { componentState, handleCopy, markdownRef, localMediaPreview, closeLocalMediaPreview } =
    useChatMarkdownState({ text, inline, ...props });
  // Streaming re-renders only the last block; offsets for task edits need the whole text.
  const streamingBlocks =
    props.isStreaming === true &&
    !inline &&
    extraRemarkPlugins.length === 0 &&
    !props.onTaskListChange
      ? splitMarkdownBlocks(text)
      : null;
  const incrementalParsing =
    props.isStreaming === true &&
    streamingBlocks === null &&
    extraRemarkPlugins.length === 0 &&
    /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
  const Root = inline ? "span" : "div";
  const bindMarkdownRef = (node: HTMLElement | null) => {
    markdownRef.current = node;
  };
  const sharedRemarkPlugins =
    CHAT_MARKDOWN_REMARK_PLUGIN_SETS[
      componentState.mathEnabled
        ? lineBreaks
          ? "mathBreaks"
          : "math"
        : lineBreaks
          ? "breaks"
          : "plain"
    ];
  // The incremental parser keeps per-instance state, so its output is not shared.
  const uncachedPlugins = incrementalParsing;
  const remarkPlugins = incrementalParsing
    ? [...sharedRemarkPlugins, ...extraRemarkPlugins, createIncrementalMarkdownPlugin()]
    : withExtraPlugins(sharedRemarkPlugins, extraRemarkPlugins);
  const blocks = streamingBlocks ?? [text];

  return (
    <Root
      ref={bindMarkdownRef}
      className={cn(
        "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word]",
        !inline &&
          "text-sm leading-relaxed text-foreground/[calc(90%+var(--appearance-contrast-boost)/10)]",
        className,
      )}
      data-streaming={componentState.isStreaming ? "" : undefined}
      onCopy={handleCopy}
    >
      <ChatMarkdownRendererContext value={componentState}>
        {blocks.map((source, index) => (
          <MarkdownSource
            // oxlint-disable-next-line react/no-array-index-key -- streamed blocks only change at the end
            key={index}
            text={source}
            remarkPlugins={remarkPlugins}
            rehypePlugins={
              parseRawHtml
                ? CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS
                : CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS
            }
            shared={!uncachedPlugins}
            // Every block before the last is finished, so its parse can be reused.
            cache={!props.isStreaming || index < blocks.length - 1}
          />
        ))}
      </ChatMarkdownRendererContext>
      {localMediaPreview ? (
        <ExpandedImageDialog preview={localMediaPreview} onClose={closeLocalMediaPreview} />
      ) : null}
    </Root>
  );
}

export default memo(ChatMarkdown);
