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
import { AuthFilesystemReadScope, AuthOrchestrationOperateScope } from "@t3tools/contracts";
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
  type AssetResource,
  type EditorId,
  type EnvironmentId,
  type ServerConfig,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { githubMediaFetchUrl } from "@t3tools/shared/githubMedia";
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
import { mediaFileReference, mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { MISSING_FILE_ACCESS_MESSAGE } from "@t3tools/client-runtime/state/assets";
import { mediaKindFromPath, mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import React, {
  Suspense,
  type CSSProperties,
  type ComponentProps,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  use,
  memo,
  useEffect,
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
import ReactMarkdown from "react-markdown";
import { createIncrementalMarkdownPlugin } from "../markdown-incremental";
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
import { markdownImageGallery, markdownImageItems } from "./chat/markdownImageGallery";
import { MediaVideoPlayer } from "./media/MediaVideoPlayer";
import { MediaActions, type MediaActionSource } from "./media/MediaActions";
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
import { useAssetUrlRefresh, useAssetUrlState } from "../assets/assetUrls";
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
  usePreparedConnection,
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
import {
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  resolvePullRequestPreviewTarget,
  useOpenChangeRequestLink,
} from "~/lib/openPullRequestLink";
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
import { MarkdownMermaidCodeBlock } from "./chat/MarkdownMermaidCodeBlock";
import { MarkdownTable } from "./chat/MarkdownTable";
import { MarkdownDetails } from "./chat/MarkdownDetails";
import { MarkdownExternalLinkContent } from "./chat/MarkdownExternalLink";
import { MarkdownFileLink } from "./chat/MarkdownFileLink";
import { canUseMarkdownFileShellActions } from "./chat/MarkdownFileLink.logic";
import { handleMarkdownFragmentClick, rehypeHeadingIds } from "./chat/markdownFragments";
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

const isAssetNotFoundError = Schema.is(AssetWorkspaceAssetNotFoundError);

interface ChatMarkdownProps {
  /** Compact markdown transforms remove blocks before rendering inside a label. */
  inline?: boolean;
  text: string;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  pullRequestPanelRef?: ScopedThreadRef | undefined;
  environmentId?: EnvironmentId | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  className?: string;
  lineBreaks?: boolean;
  parseRawHtml?: boolean;
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  onRunShellCommand?: ((command: string) => void) | undefined;
  imageBaseDir?: string | undefined;
  workspaceMutationId?: string | null | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  extraRemarkPlugins?: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  /** Loads GitHub-hosted media through `cwd`'s GitHub credential, which a private repository's
      uploads need; without it those images and videos load unauthenticated and 404. */
  githubMedia?: boolean | undefined;
  headingLevelOffset?: number | undefined;
}

export interface ChatMarkdownContextReference {
  kind: string;
  contextId: string;
  label: string;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [];

const ARTIFACT_TEMPLATE_ICON_BY_KIND = {
  document: FileTextIcon,
  presentation: PresentationIcon,
  spreadsheet: FileSpreadsheetIcon,
  site: GlobeIcon,
  "google-docs": FileTextIcon,
  "google-slides": PresentationIcon,
  "google-sheets": FileSpreadsheetIcon,
  image: ImageIcon,
  email: MailIcon,
  slack: MessageSquareIcon,
} satisfies Record<CodexArtifactTemplateKind, LucideIcon>;

function CodexArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
}) {
  const Icon = ARTIFACT_TEMPLATE_ICON_BY_KIND[props.template.artifactKind];
  const presentationLabel = codexArtifactTemplatePresentationLabel(props.template.artifactKind);

  return (
    <div
      role="group"
      aria-label={`${props.template.displayName} template`}
      data-chat-markdown-artifact-template
      className="my-[0.65rem] flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-foreground shadow-xs"
      data-artifact-kind={props.template.artifactKind}
      data-markdown-copy={`${props.template.displayName} (${presentationLabel})\n\n`}
      data-skill-name={props.template.skillName}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground shadow-xs">
          <Icon aria-hidden className="size-5" />
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-background bg-primary text-primary-foreground shadow-xs">
            <SparklesIcon aria-hidden className="size-2.5" />
          </span>
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {props.template.displayName}
          </div>
          <div className="text-xs text-muted-foreground">{presentationLabel}</div>
        </div>
      </div>
      {props.onUse ? (
        <Button
          data-thread-find-ignore
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => props.onUse?.(props.template)}
        >
          Use template
        </Button>
      ) : null}
    </div>
  );
}

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

function orderedListGutterStyle(
  itemCount: number,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` };
}

const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
> = {
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-blue-600 dark:text-blue-400",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-red-500/70",
    titleClassName: "text-red-600 dark:text-red-400",
  },
};

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

const CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME = "max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME = cn(
  "max-h-[30rem]",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
);
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
const CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME = "rounded-lg border border-border/40";
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  "h-auto w-auto object-contain",
  CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
);

function markdownImageCopy(alt: string, src: string, title: string | undefined): string {
  const escapedAlt = alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const titleSuffix =
    title === undefined ? "" : ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `![${escapedAlt}](${src}${titleSuffix})`;
}

/**
 * `maxHeightRem` folds a height cap into the width bound: `max-height` alone
 * would not feed back through `aspect-ratio` once `width` is definite, so a
 * tall image would keep a box wider than the picture it draws.
 */
function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
  maxHeightRem = 30,
): CSSProperties | undefined {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0;
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0;
  if (hasWidth && hasHeight) {
    return {
      width: parsedWidth,
      height: "auto",
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(maxHeightRem * parsedWidth) / parsedHeight}rem)`,
    };
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` };
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` };
  return undefined;
}

const CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME = cn(
  CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);
const MarkdownLinkContext = React.createContext(false);

function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  alt: string,
) {
  if (!onImageExpand) return {};
  const previewName = alt.trim() || "image";
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = markdownImageItems.get(event.currentTarget);
    if (item) onImageExpand(markdownImageGallery(event.currentTarget, item));
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${previewName}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}

function ChatMarkdownMediaUnavailableLabel(props: {
  readonly alt: string;
  readonly kind?: "image" | "video" | undefined;
  readonly detail?: string | undefined;
}) {
  const label = props.kind === "video" ? "Video unavailable" : "Image unavailable";
  return (
    <span data-thread-find-ignore className="inline-flex items-center gap-1.5">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {[label, props.alt, props.detail].filter(Boolean).join(" · ")}
    </span>
  );
}

function ChatMarkdownImageFallback(props: {
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
  readonly kind?: "image" | "video";
  readonly actionsSource?: MediaActionSource | undefined;
  readonly detail?: string | undefined;
}) {
  const content = (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        "rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      <ChatMarkdownMediaUnavailableLabel alt={props.alt} kind={props.kind} detail={props.detail} />
    </span>
  );
  return props.actionsSource ? (
    <MediaActions source={props.actionsSource}>{content}</MediaActions>
  ) : (
    content
  );
}

const CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME = cn(
  "aspect-video w-full overflow-hidden bg-muted/60",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);

/**
 * Callers key this on the file's identity, not its URL: a re-signed URL for
 * the same file keeps the decoded image on screen while the new bytes arrive,
 * and a different file starts from the slot again.
 */
function ChatMarkdownImage(props: {
  readonly src: string | null;
  readonly sourceFailed?: boolean | undefined;
  readonly unavailableDetail?: string | undefined;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly standalone: boolean;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly actionsSource: MediaActionSource;
  readonly originalUrl?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = props.src ?? loadedSrc;
  const failed = props.sourceFailed === true || (src !== null && failedSrc === src);
  const settled = src !== null && !failed && (!props.standalone || loadedSrc !== null);
  // Cached images are complete before `onLoad` can fire.
  const markLoadedIfComplete = (image: HTMLImageElement | null) => {
    if (!image) return;
    if (image.complete && image.naturalWidth > 0) setLoadedSrc(image.currentSrc || image.src);
    markdownImageItems.set(image, {
      src,
      name: props.alt.trim() || "image",
      actionsSource: props.actionsSource,
      ...(props.originalUrl ? { originalUrl: props.originalUrl } : {}),
    });
  };
  const imageEvents = (loadingSrc: string) => ({
    onLoad: () => {
      setLoadedSrc(loadingSrc);
      setFailedSrc(null);
    },
    onError: () => {
      setFailedSrc(loadingSrc);
      setLoadedSrc(null);
    },
  });

  if (settled) {
    return (
      <MediaActions source={props.actionsSource}>
        <img
          {...props.imageProps}
          ref={markLoadedIfComplete}
          src={src}
          alt={props.alt}
          data-markdown-copy={props.copyMarkdown}
          decoding="async"
          draggable={false}
          className={cn(
            CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
            props.className,
            props.onImageExpand && "cursor-zoom-in",
          )}
          style={props.style}
          {...expandableMarkdownImageProps(props.onImageExpand, props.alt)}
          {...imageEvents(src)}
        />
      </MediaActions>
    );
  }
  if (!props.standalone) {
    return failed ? (
      <ChatMarkdownImageFallback
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        actionsSource={props.actionsSource}
        detail={props.unavailableDetail}
      />
    ) : (
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        role="status"
        aria-label="Loading image"
        className={CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME}
      />
    );
  }
  return (
    <MediaActions source={props.actionsSource}>
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        className={cn(
          CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
          CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME,
          "relative",
        )}
        style={props.style}
        {...(failed
          ? { role: "alert" as const }
          : { role: "status" as const, "aria-label": "Loading image" })}
      >
        {failed ? (
          <span className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
            <ChatMarkdownMediaUnavailableLabel alt={props.alt} detail={props.unavailableDetail} />
          </span>
        ) : src !== null ? (
          <img
            ref={markLoadedIfComplete}
            src={src}
            alt={props.alt}
            decoding="async"
            draggable={false}
            className="invisible absolute inset-0 size-full"
            {...imageEvents(src)}
          />
        ) : null}
      </span>
    </MediaActions>
  );
}

function ChatMarkdownVideo(props: {
  readonly src: string | null;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly originalUrl?: string | undefined;
  readonly sourceFailed?: boolean | undefined;
  readonly style?: CSSProperties | undefined;
  readonly mediaIdentity?: string | undefined;
  readonly actionsSource?: MediaActionSource | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
}) {
  return (
    <MediaVideoPlayer
      key={props.mediaIdentity ?? props.copyMarkdown ?? props.src}
      src={props.src}
      sourceFailed={props.sourceFailed}
      label={props.alt}
      originalUrl={props.originalUrl}
      style={props.style}
      copyMarkdown={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
        "w-full",
      )}
      videoClassName={cn(
        CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
      )}
      onRetry={props.onRetry}
      actionsSource={props.actionsSource}
    />
  );
}

export const ChatMarkdownAssetImage = memo(function ChatMarkdownAssetImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<
    AssetResource,
    {
      readonly _tag:
        | "attachment"
        | "workspace-file"
        | "media-file"
        | "github-media"
        | "tool-output-image";
    }
  >;
  readonly kind?: "image" | "video";
  readonly alt: string;
  readonly copyMarkdown?: string;
  readonly srcFragment?: string;
  readonly standalone?: boolean | undefined;
  readonly maxHeightRem?: number | undefined;
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly originalUrl?: string | undefined;
  readonly framed?: boolean | undefined;
  readonly fallbackSrc?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly workspaceMutationId?: string | null | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, props.resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, props.resource);
  const connectionReady = usePreparedConnection(props.environmentId)._tag === "Some";
  const resource = props.resource;
  const refreshToken = JSON.stringify([props.environmentId, resource, props.workspaceMutationId]);
  const handledRefreshToken = useRef<string | null | undefined>(undefined);
  const assetLoading = assetUrl._tag === "Loading" || assetUrl.waiting === true;
  useEffect(() => {
    if (!connectionReady) {
      handledRefreshToken.current = null;
      return;
    }
    if (
      props.workspaceMutationId === undefined ||
      props.kind === "video" ||
      (resource._tag !== "media-file" && resource._tag !== "workspace-file") ||
      handledRefreshToken.current === refreshToken
    ) {
      return;
    }
    if (assetLoading) {
      // Only the initial mount shares a pending request; edits and reconnects need a new one.
      if (handledRefreshToken.current === undefined) {
        handledRefreshToken.current = refreshToken;
      }
      return;
    }
    handledRefreshToken.current = refreshToken;
    void refreshAssetUrl().catch(() => undefined);
  }, [
    assetLoading,
    connectionReady,
    props.kind,
    props.workspaceMutationId,
    refreshAssetUrl,
    refreshToken,
    resource._tag,
  ]);
  const path =
    resource._tag === "media-file"
      ? resource.path
      : resource._tag === "workspace-file" && props.workspaceRoot
        ? `${props.workspaceRoot.replace(/[\\/]+$/, "")}/${resource.path}`
        : undefined;
  const reference = path
    ? mediaFileReference(path, props.workspaceRoot)
    : props.originalUrl
      ? mediaUrlReference(props.originalUrl)
      : undefined;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  const fallbackSrc = assetUrl._tag === "Failure" ? props.fallbackSrc : undefined;
  const src =
    assetUrl._tag === "Success"
      ? assetUrl.url + (props.srcFragment ?? "")
      : fallbackSrc === undefined
        ? null
        : fallbackSrc + (props.srcFragment ?? "");
  const knownSize = assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined;
  const maxHeightRem = props.maxHeightRem ?? 30;
  const style =
    props.style ??
    (knownSize
      ? authoredImageSizeStyle(knownSize.width, knownSize.height, maxHeightRem)
      : maxHeightRem !== 30
        ? { maxHeight: `${maxHeightRem}rem` }
        : undefined);
  const actionsSource: MediaActionSource = {
    kind: props.kind ?? "image",
    name: props.alt || (props.kind ?? "image"),
    src,
    ...(fallbackSrc === undefined
      ? { asset: { environmentId: props.environmentId, resource } }
      : {}),
    ...(reference ? { reference } : {}),
    ...(relativePath && (resource._tag === "media-file" || resource._tag === "workspace-file")
      ? {
          onOpenFile: () =>
            useRightPanelStore
              .getState()
              .openFile(
                { environmentId: props.environmentId, threadId: resource.threadId },
                relativePath,
              ),
        }
      : {}),
  };

  if (props.kind === "video") {
    return (
      <ChatMarkdownVideo
        src={src}
        sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        originalUrl={props.originalUrl}
        style={props.style}
        mediaIdentity={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
        onRetry={refreshAssetUrl}
        actionsSource={actionsSource}
      />
    );
  }

  return (
    <ChatMarkdownImage
      key={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
      src={src}
      sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
      unavailableDetail={
        assetUrl._tag === "Failure" &&
        assetUrl.reason === "missing-file-access" &&
        fallbackSrc === undefined
          ? MISSING_FILE_ACCESS_MESSAGE
          : undefined
      }
      alt={props.alt}
      copyMarkdown={props.copyMarkdown}
      standalone={props.standalone ?? true}
      className={cn(
        props.framed === false ? undefined : CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME,
        props.className,
      )}
      style={style}
      imageProps={props.imageProps}
      actionsSource={actionsSource}
      originalUrl={props.originalUrl}
      onImageExpand={props.onImageExpand}
    />
  );
});

// Heading ids are added after sanitizing, which would prefix them a second time.
const CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS = [
  ...CHAT_MARKDOWN_REHYPE_PLUGINS,
  rehypeHeadingIds,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

const CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS = [rehypeHeadingIds] satisfies NonNullable<
  ReactMarkdownOptions["rehypePlugins"]
>;

const NO_MARKDOWN_EDITORS: ReadonlyArray<EditorId> = [];

type MarkdownServerConfigFields = ReturnType<typeof markdownServerConfigFields>;

/** The server config fields markdown reads. */
function markdownServerConfigFields(config: ServerConfig | null) {
  return {
    pullRequestsEnabled: config?.environment.capabilities.pullRequests === true,
    availableEditors: config?.availableEditors ?? NO_MARKDOWN_EDITORS,
    revealInFileManagerLabel:
      config?.shellRevealInFileManager === true && config.availableEditors.includes("file-manager")
        ? config.shellRevealInFileManagerKind === undefined
          ? revealInFileExplorerLabelForOs(config.environment.platform.os)
          : revealInFileExplorerLabelForKind(config.shellRevealInFileManagerKind)
        : undefined,
  };
}

function markdownServerConfigFieldsEqual(
  previous: MarkdownServerConfigFields,
  next: MarkdownServerConfigFields,
): boolean {
  return (
    previous.pullRequestsEnabled === next.pullRequestsEnabled &&
    previous.revealInFileManagerLabel === next.revealInFileManagerLabel &&
    previous.availableEditors.length === next.availableEditors.length &&
    previous.availableEditors.every((editor, index) => editor === next.availableEditors[index])
  );
}

// The config object changes with every provider status push and snapshot. The
// atom keeps its previous value while the fields markdown reads are equal, so
// those pushes don't re-render every visible reply.
const markdownServerConfigFieldsAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => {
    const next = markdownServerConfigFields(get(serverEnvironment.configValueAtom(environmentId)));
    const previous = Option.getOrNull(get.self<MarkdownServerConfigFields>());
    return previous !== null && markdownServerConfigFieldsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("markdown-server-config-fields")),
);

function useChatMarkdownState({
  text,
  inline = false,
  cwd,
  threadRef,
  pullRequestPanelRef,
  environmentId: explicitEnvironmentId,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  onUseArtifactTemplate,
  onRunShellCommand,
  imageBaseDir,
  workspaceMutationId,
  onImageExpand,
  renderContextReference,
  headingLevelOffset = 0,
  githubMedia = false,
}: ChatMarkdownProps) {
  const resolvedTheme = useRenderedAppearance();
  const markdownRef = useRef<HTMLElement>(null);
  const mediaRequestId = useRef(0);
  // A preview opened from another thread or workspace never carries over.
  const mediaScopeKey = [
    threadRef?.environmentId,
    threadRef?.threadId,
    explicitEnvironmentId,
    cwd,
    imageBaseDir,
  ].join("\u0000");
  // Tagged with the scope it was opened in: a request from the previous scope can
  // resolve before the effect cleanup below invalidates it, and must stay hidden.
  const [localMedia, setLocalMedia] = useState<{
    scope: string;
    preview: ExpandedImagePreview;
  } | null>(null);
  const localMediaPreview = localMedia?.scope === mediaScopeKey ? localMedia.preview : null;
  const closeLocalMediaPreview = () => setLocalMedia(null);
  const expandMedia =
    onImageExpand ??
    ((preview: ExpandedImagePreview) => setLocalMedia({ scope: mediaScopeKey, preview }));
  const [mediaScope, setMediaScope] = useState(mediaScopeKey);
  if (mediaScope !== mediaScopeKey) {
    setMediaScope(mediaScopeKey);
    setLocalMedia(null);
  }
  // A layout cleanup runs in the commit that changes scope, so a request resolving
  // before paint cannot reach a parent onImageExpand either.
  useLayoutEffect(
    () => () => {
      mediaRequestId.current += 1;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Leaving the scope invalidates media requests still loading for it.
    [mediaScopeKey],
  );
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const searchProjectEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  const getFilesystemMetadata = useAtomQueryRunner(filesystemEnvironment.getMetadata, {
    reportFailure: false,
    refresh: true,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const pullRequestLinking = usePullRequestLinking(threadRef?.environmentId);
  const environmentId = threadRef?.environmentId ?? explicitEnvironmentId ?? null;
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const canUseShellActions =
    canOperateHost &&
    canUseMarkdownFileShellActions(environmentId, remoteOpen.state.mode, remoteOpen.isResolved);
  const openMarkdownMedia = (
    source: string,
    resolvedFilePath?: string,
    clickedImage?: HTMLImageElement | null,
  ) => {
    const requestId = ++mediaRequestId.current;
    void resolveMarkdownMediaPreview({
      source,
      resolvedFilePath,
      cwd,
      threadRef,
      // Read at click time: a reconnect replaces the prepared connection, and
      // subscribing would hand every rendered markdown element a new context.
      httpBaseUrl:
        environmentId === null ? undefined : readPreparedConnection(environmentId)?.httpBaseUrl,
      createAssetUrl,
      onOpenFile: threadRef
        ? (path) => useRightPanelStore.getState().openFile(threadRef, path)
        : undefined,
    }).then(
      (preview) => {
        if (preview && mediaRequestId.current === requestId) {
          const selected = preview.images[preview.index];
          expandMedia(
            selected && selected.type !== "video" && markdownRef.current
              ? markdownImageGallery(clickedImage ?? markdownRef.current, selected)
              : preview,
          );
        }
      },
      (error: unknown) => {
        if (mediaRequestId.current !== requestId) return;
        let description =
          error instanceof Error
            ? error.message
            : "The file could not be loaded. It may have been moved or deleted.";
        if (
          isAssetNotFoundError(error) &&
          error.resource._tag === "media-file" &&
          environmentId !== null
        ) {
          // The connection may resolve while the media lookup is pending.
          const target = readPreparedConnection(environmentId)?.target ?? null;
          if (
            target !== null &&
            resolveRemoteOpenState({
              target,
              sshTarget: null,
              remoteOpenTargets: undefined,
              isDesktopRenderer: window.desktopBridge !== undefined,
            }).mode !== "local-exec"
          ) {
            description = `The file was not found on ${target.label} at ${error.checkedPath ?? error.resource.path}.`;
          }
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Media unavailable",
            description,
          }),
        );
      },
    );
  };
  const { pullRequestsEnabled, availableEditors, revealInFileManagerLabel } = useAtomValue(
    markdownServerConfigFieldsAtom(environmentId),
  );
  const projects = useProjects();
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const preferredEditorMenuLabel = openInEditorMenuLabel(preferredEditor);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const revealFileInFileManager = (filePath: string) => {
    if (environmentId === null) {
      return Promise.resolve(
        AsyncResult.failure<void, PreferredEditorEnvironmentRequiredError>(
          Cause.fail(new PreferredEditorEnvironmentRequiredError({ targetPath: filePath })),
        ),
      );
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return Promise.resolve(
        AsyncResult.failure<void, Error>(
          Cause.fail(new Error("This connection cannot reveal files on this environment.")),
        ),
      );
    }
    return openInEditor({
      environmentId,
      input: { cwd: filePath, editor: "file-manager", reveal: true },
    });
  };
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownFileLinkMetaByHref = (() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of extractMarkdownLinkHrefs(renderCodexInlineDirectivesAsMarkdown(text))) {
      if (parseComposerContextHref(href)) continue;
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  })();
  const inlineCodeFileLinkMetaByText = (() => {
    const metaByText = new Map<string, MarkdownFileLinkMeta>();
    for (const span of extractInlineCodeSpans(text)) {
      if (metaByText.has(span)) continue;
      const meta = resolveInlineCodeFileLinkMeta(span, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByText.set(span, meta);
      }
    }
    return metaByText;
  })();
  const fileLinkParentSuffixByPath = (() => {
    const filePaths = [
      ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
      ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
    ];
    return buildFileLinkParentSuffixByPath(filePaths);
  })();
  const markdownUrlTransform = (href: string) => {
    if (parseAssistantCitationHref(href)) return href;
    if (parseComposerContextHref(href)) return href;
    if (parseThreadLinkHref(href)) return href;
    if (isWindowsDrivePathHref(href)) return href;
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  };
  const handleCopy = (event: ReactClipboardEvent<HTMLElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    const fragment = event.clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME);
    event.clipboardData.setData(
      "text/html",
      fragment
        ? encodeComposerContextClipboardHtml(payload.text, fragment, payload.html)
        : payload.html,
    );
  };
  const openChangeRequestLink = useOpenChangeRequestLink(threadRef, pullRequestPanelRef);
  const openDeferredMarkdownLink = useOpenLink(threadRef);
  // Subscribed rather than read at click time: the anchor has to decide
  // synchronously whether to intercept its `_blank`, and a subscription is what
  // makes a persisted "app" apply once settings hydrate after launch.
  const linkTargetPreference = useClientSettings((settings) => settings.browserLinkTarget);
  const mathEnabled = useClientSettings((settings) => settings.mathRenderingEnabled);
  const resolveThreadPullRequest = (
    href: string,
  ): (ThreadPullRequestKey & { readonly url: string }) | null => {
    if (
      threadRef === undefined ||
      readThreadShell(threadRef) === null ||
      !pullRequestLinking.canLink(href)
    )
      return null;
    const parsed = parseChangeRequestUrl(href);
    return parsed === null ? null : { ...parsed, url: href };
  };
  const linkedThreadPullRequestFor = (href: string) => {
    if (threadRef === undefined || !pullRequestLinking.isLinked(readThreadShell(threadRef), href))
      return null;
    const parsed = parseChangeRequestUrl(href);
    return parsed === null ? null : { ...parsed, url: href };
  };
  const updateThreadPullRequestLink = async (href: string, linked: boolean) => {
    if (threadRef === undefined || (!linked && linkedThreadPullRequestFor(href) === null)) return;
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    await pullRequestLinking.changeLink(threadRef, href, linked);
  };
  const openExternalLinkInPreview = (url: string) => {
    if (!threadRef || !canOperatePreview) {
      return Promise.resolve(
        AsyncResult.failure<void, BrowserPreviewUnavailableError>(
          Cause.fail(
            new BrowserPreviewUnavailableError({
              message: "Preview access is unavailable for this client.",
            }),
          ),
        ),
      );
    }
    return openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
      if (result._tag === "Success") recordVisitForThread(threadRef, url);
      else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        if (error instanceof BrowserSettingsReadError) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open link in browser",
              description: error.message,
            }),
          );
        }
      }
      return result;
    });
  };
  const openMarkdownFileInPreview = (path: string) => {
    const preparedConnection = threadRef ? readPreparedConnection(threadRef.environmentId) : null;
    if (!threadRef || !canOperatePreview || preparedConnection === null) {
      return Promise.resolve(
        AsyncResult.failure<void, BrowserPreviewUnavailableError>(
          Cause.fail(
            new BrowserPreviewUnavailableError({
              message: "Environment is not connected.",
            }),
          ),
        ),
      );
    }
    return openFileInPreview({
      threadRef,
      filePath: path,
      workspaceRoot: cwd,
      httpBaseUrl: preparedConnection.httpBaseUrl,
      createAssetUrl,
      openPreview,
    });
  };
  const findWorkspaceFileMatch = async (fileLinkMeta: MarkdownFileLinkMeta) => {
    const workspaceRelativePath = fileLinkMeta.workspaceLookupPath;
    if (
      !workspaceRelativePath ||
      !cwd ||
      environmentId === null ||
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
    ) {
      return null;
    }
    const isBasename = needsWorkspaceBasenameLookup(workspaceRelativePath);
    const strippedPath = isBasename
      ? null
      : stripRepeatedWorkspacePrefix(workspaceRelativePath, cwd);
    if (!isBasename && strippedPath === null) return null;
    const result = await searchProjectEntries({
      environmentId,
      input: {
        cwd,
        query: strippedPath ?? workspaceRelativePath,
        limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
        kind: "file",
      },
    });
    if (result._tag !== "Success") return null;
    if (strippedPath === null) {
      return pickWorkspaceBasenameMatch(workspaceRelativePath, result.value.entries);
    }
    const match = pickStrippedWorkspaceMatch(strippedPath, cwd, result.value.entries);
    if (match === null) return null;
    // Search can be truncated or still scanning, so it cannot rule out the
    // literal path. Check the host before redirecting to the stripped match.
    const metadata = await getFilesystemMetadata({
      environmentId,
      input: { paths: [resolveWorkspaceFilePath(workspaceRelativePath, cwd)] },
    });
    return metadata._tag === "Success" && metadata.value.entries[0] === null ? match : null;
  };
  const openFileInPanel = (fileLinkMeta: MarkdownFileLinkMeta, panelPath: string) => {
    if (!threadRef) return;
    // Claimed on every open so a synchronous one supersedes a lookup already
    // in flight.
    const isLatestLookup = claimWorkspaceBasenameLookup();
    const openAt = (path: string) =>
      useRightPanelStore.getState().openFile(threadRef, path, fileLinkMeta.line);
    if (
      fileLinkMeta.workspaceLookupPath === null ||
      !cwd ||
      (!needsWorkspaceBasenameLookup(panelPath) &&
        stripRepeatedWorkspacePrefix(panelPath, cwd) === null)
    ) {
      openAt(panelPath);
      return;
    }
    void (async () => {
      const match = await findWorkspaceFileMatch(fileLinkMeta);
      if (!isLatestLookup()) return;
      openAt(match ?? panelPath);
    })();
  };
  const fileLinkChip = (
    fileLinkMeta: MarkdownFileLinkMeta,
    copyMarkdown: string,
    mediaSource?: string,
  ) => {
    const resolveHostPath = () =>
      resolveMarkdownFileHostPath({
        meta: fileLinkMeta,
        cwd,
        findWorkspaceMatch: () => findWorkspaceFileMatch(fileLinkMeta),
      });
    const mediaPath = mediaSource ?? fileLinkMeta.filePath;
    const canPreviewMedia =
      mediaMimeTypeFromExtension(
        fileLinkMeta.basename.slice(fileLinkMeta.basename.lastIndexOf(".")),
      ) !== null;
    const panelPath =
      fileLinkMeta.workspaceRelativePath ??
      (!canPreviewMedia && isHostPath(fileLinkMeta.filePath) ? fileLinkMeta.filePath : null);

    return (
      <MarkdownFileLink
        environmentId={environmentId}
        href={fileLinkMeta.targetPath}
        targetPath={fileLinkMeta.targetPath}
        iconPath={fileLinkMeta.filePath}
        workspaceRelativePath={fileLinkMeta.workspaceRelativePath}
        panelPath={panelPath}
        line={fileLinkMeta.line}
        label={fileLinkLabel(
          {
            path: fileLinkMeta.filePath,
            ...(fileLinkMeta.line !== undefined ? { line: fileLinkMeta.line } : {}),
            ...(fileLinkMeta.column !== undefined ? { column: fileLinkMeta.column } : {}),
          },
          fileLinkParentSuffixByPath,
        )}
        copyMarkdown={copyMarkdown}
        theme={resolvedTheme}
        threadRef={threadRef}
        onOpen={
          canUseShellActions
            ? async () =>
                openInPreferredEditor(
                  markdownFileEditorTarget(fileLinkMeta, await resolveHostPath()),
                )
            : undefined
        }
        resolveCopyPaths={async () =>
          markdownFileCopyPaths(fileLinkMeta, await resolveHostPath(), cwd)
        }
        onOpenInPanel={(path) => openFileInPanel(fileLinkMeta, path)}
        onOpenMedia={
          threadRef && canPreviewMedia
            ? () => openMarkdownMedia(mediaPath, fileLinkMeta.filePath)
            : undefined
        }
        openInEditorMenuLabel={preferredEditorMenuLabel}
        onReveal={
          canUseShellActions && revealInFileManagerLabel !== undefined
            ? async () => revealFileInFileManager((await resolveHostPath()).absolutePath)
            : undefined
        }
        revealLabel={revealInFileManagerLabel}
        onOpenInBrowser={
          threadRef &&
          canOperatePreview &&
          isPreviewAvailableFor(threadRef.environmentId) &&
          isBrowserPreviewFile(fileLinkMeta.filePath)
            ? () => openMarkdownFileInPreview(fileLinkMeta.filePath)
            : undefined
        }
      />
    );
  };

  const componentState = {
    canOperateHost,
    canOperatePreview,
    cwd,
    diffThemeName,
    environmentId,
    expandMedia,
    fileLinkChip,
    githubMedia,
    renderContextReference,
    headingLevelOffset,
    imageBaseDir,
    workspaceMutationId,
    inlineCodeFileLinkMetaByText,
    inline,
    mathEnabled,
    isStreaming,
    linkTargetPreference,
    markdownFileLinkMetaByHref,
    onTaskListChange,
    onUseArtifactTemplate,
    onRunShellCommand,
    openChangeRequestLink,
    openDeferredMarkdownLink,
    openExternalLinkInPreview,
    openMarkdownMedia,
    projects,
    linkedThreadPullRequestFor,
    resolveThreadPullRequest,
    resolvedTheme,
    pullRequestsEnabled,
    skills,
    threadRef,
    updateThreadPullRequestLink,
  };
  return {
    componentState,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    closeLocalMediaPreview,
  };
}

const ChatMarkdownRendererContext = React.createContext<
  ReturnType<typeof useChatMarkdownState>["componentState"]
>(null!);

// The markdown source changes on every streamed delta. Only the renderers that
// slice it by node offset read it, so it sits apart from the renderer context.
const ChatMarkdownTextContext = React.createContext("");

function markdownHeadingRenderer(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({
    node: _node,
    ...props
  }: ComponentProps<typeof Tag> & ReactMarkdownExtraProps) {
    const { headingLevelOffset } = use(ChatMarkdownRendererContext);
    return (
      <Tag
        {...props}
        aria-level={headingLevelOffset > 0 ? Math.min(level + headingLevelOffset, 6) : undefined}
      />
    );
  };
}

// Keep component types stable when streaming changes the message state.
const CHAT_MARKDOWN_COMPONENTS = {
  h1: markdownHeadingRenderer(1),
  h2: markdownHeadingRenderer(2),
  h3: markdownHeadingRenderer(3),
  h4: markdownHeadingRenderer(4),
  h5: markdownHeadingRenderer(5),
  h6: markdownHeadingRenderer(6),
  div: function MarkdownDiv({ node, children, ...props }) {
    const { onUseArtifactTemplate } = use(ChatMarkdownRendererContext);
    const artifactTemplate = artifactTemplateFromHastProperties(node?.properties);
    if (artifactTemplate) {
      return (
        <CodexArtifactTemplateCard template={artifactTemplate} onUse={onUseArtifactTemplate} />
      );
    }
    return <div {...props}>{children}</div>;
  },
  p: function MarkdownParagraph({ node: _node, children, ...props }) {
    const { skills } = use(ChatMarkdownRendererContext);
    return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
  },
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const alert =
      GITHUB_ALERT_PRESENTATIONS[String((props as Record<string, unknown>)["data-alert"] ?? "")];
    if (!alert) {
      return <blockquote {...props}>{children}</blockquote>;
    }
    return (
      <div role="note" className={cn("my-1 border-l-2 pl-3", alert.borderClassName)}>
        <p
          data-thread-find-ignore="true"
          className={cn("flex items-center gap-1.5 font-medium", alert.titleClassName)}
        >
          <alert.Icon aria-hidden className="size-3.5 shrink-0" />
          {alert.label}
        </p>
        {children}
      </div>
    );
  },
  ol: function MarkdownOrderedList({ node, start, style, ...props }) {
    const itemCount =
      node?.children?.filter((child) => child.type === "element" && child.tagName === "li")
        .length ?? 0;
    const gutterStyle = orderedListGutterStyle(itemCount, start);
    return (
      <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
    );
  },
  li: function MarkdownListItem({ node, children, ...props }) {
    const { skills } = use(ChatMarkdownRendererContext);
    // The checkbox finds its marker from this offset when toggled, so list items
    // don't read the source text and re-render on every streamed token.
    // remark-gfm marks task items with this class; plain items carry no offset.
    const isTaskItem = String(props.className ?? "").includes("task-list-item");
    return (
      <li {...props} data-list-item-offset={isTaskItem ? node?.position?.start.offset : undefined}>
        {renderSkillInlineMarkdownChildren(children, skills)}
      </li>
    );
  },
  input: function MarkdownInput({ node: _node, type, checked, disabled: _disabled, ...props }) {
    const { onTaskListChange } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    if (type !== "checkbox" || !onTaskListChange) {
      return (
        <input
          {...props}
          type={type}
          checked={checked}
          disabled={_disabled}
          readOnly={type === "checkbox"}
        />
      );
    }
    return (
      <input
        {...props}
        type="checkbox"
        name="markdown-task"
        aria-label="Toggle task"
        checked={checked}
        onChange={(event) => {
          const listItemStart = Number(event.currentTarget.closest("li")?.dataset.listItemOffset);
          if (!Number.isSafeInteger(listItemStart)) return;
          const markerOffset = findTaskListMarkerOffset(text, listItemStart);
          if (markerOffset === null) return;
          onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
        }}
      />
    );
  },
  a: function MarkdownAnchor({ node, href, children, title: _title, ...props }) {
    const {
      canOperateHost,
      canOperatePreview,
      cwd,
      environmentId,
      imageBaseDir,
      markdownFileLinkMetaByHref,
      threadRef,
      openMarkdownMedia,
      openChangeRequestLink,
      openDeferredMarkdownLink,
      linkTargetPreference,
      openExternalLinkInPreview,
      projects,
      linkedThreadPullRequestFor,
      resolveThreadPullRequest,
      pullRequestsEnabled,
      updateThreadPullRequestLink,
      fileLinkChip,
      renderContextReference,
    } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    const citation = href ? parseAssistantCitationHref(href) : null;
    if (citation) return <AssistantCitationChip citation={citation} />;
    const linkedThreadId = href ? parseThreadLinkHref(href) : null;
    if (linkedThreadId) {
      const label = hastPlainTextDeep(node) || linkedThreadId;
      return environmentId ? (
        <MarkdownThreadLink environmentId={environmentId} threadId={linkedThreadId} label={label} />
      ) : (
        <span>{label}</span>
      );
    }
    const contextReference = href ? parseComposerContextHref(href) : null;
    if (contextReference) {
      const label = hastPlainTextDeep(node) || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }
    const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
    const fileLinkMeta = normalizedHref
      ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
        resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd))
      : null;
    if (!fileLinkMeta) {
      const faviconHost = resolveExternalWebLinkHost(href);
      const hasText = hastHasText(node);
      const pullRequestAutolink = String(
        (props as Record<string, unknown>)["data-pull-request-autolink"] ?? "",
      );
      const pullRequestCopy =
        pullRequestAutolink === "commit"
          ? /\/commit\/([0-9a-f]{40})$/iu.exec(href ?? "")?.[1]
          : pullRequestAutolink === "reference"
            ? plainHastText(node)
            : undefined;
      const isPullRequestAutolink = pullRequestCopy !== undefined;
      const confirmBeforeOpen = pullRequestAutolink === "reference";
      const pullRequestCandidateUrl =
        confirmBeforeOpen && href ? pullRequestCandidateUrlFromReferenceAutolink(href) : href;
      const pullRequestPreviewTarget = pullRequestCandidateUrl
        ? resolvePullRequestPreviewTarget({
            environmentId,
            projects,
            pullRequestsEnabled,
            url: pullRequestCandidateUrl,
          })
        : null;
      const isSameDocumentLink = href?.startsWith("#") ?? false;
      const onClick = props.onClick;
      const canOpenInPreview =
        canOperatePreview && Boolean(threadRef && isPreviewAvailableFor(threadRef.environmentId));
      const linkChildren = <MarkdownLinkContext value>{children}</MarkdownLinkContext>;
      const link = (
        <a
          {...props}
          className={cn(props.className, pullRequestAutolink === "commit" && "font-mono")}
          data-markdown-copy={pullRequestCopy}
          data-markdown-image-link={!hasText || undefined}
          href={href}
          target={isSameDocumentLink ? undefined : "_blank"}
          rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
          onClick={(event) => {
            onClick?.(event);
            if (isSameDocumentLink && href) {
              handleMarkdownFragmentClick(event, href);
              return;
            }
            if (
              href &&
              faviconHost !== null &&
              mediaKindFromPath(href) !== null &&
              !event.defaultPrevented &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey
            ) {
              event.preventDefault();
              event.stopPropagation();
              openMarkdownMedia(
                href,
                undefined,
                event.target instanceof HTMLImageElement
                  ? event.target
                  : event.currentTarget.querySelector("img"),
              );
              return;
            }
            if (
              !href ||
              openChangeRequestLink(event, href, undefined, environmentId ?? undefined)
            ) {
              return;
            }
            if (event.defaultPrevented) return;
            if (
              resolveLinkTarget({
                url: href,
                event,
                preference: linkTargetPreference,
                canOpenInApp: canOpenInPreview,
              }) !== "app"
            ) {
              // Chromium turns an Option/Alt-click into a download that never reaches the
              // shell. On desktop, open the link here while the key is still down, so link
              // routers such as Finicky can still read it.
              if (isElectron && event.altKey) {
                event.preventDefault();
                event.stopPropagation();
                void readLocalApi()
                  ?.shell.openExternal(href)
                  .catch((cause) =>
                    reportMarkdownActionFailure(
                      { operation: "open-link-external", target: href },
                      cause,
                    ),
                  );
              }
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            void openExternalLinkInPreview(href).then((result) => {
              if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
              reportMarkdownActionFailure(
                { operation: "open-link-in-preview", target: href },
                result.cause,
              );
              if (squashAtomCommandFailure(result) instanceof BrowserSettingsReadError) return;
              void readLocalApi()?.shell.openExternal(href);
            });
          }}
          onContextMenu={(event) => {
            if (!href || !faviconHost) return;
            event.preventDefault();
            event.stopPropagation();
            const api = readLocalApi();
            if (!api) return;
            const threadLinkAction = !canOperateHost
              ? undefined
              : linkedThreadPullRequestFor(href) !== null
                ? "unlink-from-thread"
                : resolveThreadPullRequest(href) === null
                  ? undefined
                  : "link-to-thread";
            void showExternalLinkContextMenu({
              href,
              canOpenInPreview,
              threadLinkAction,
              position: { x: event.clientX, y: event.clientY },
              showContextMenu: (items, position) => api.contextMenu.show(items, position),
              openInPreview: async (target) => {
                const result = await openExternalLinkInPreview(target);
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                  reportMarkdownActionFailure(
                    { operation: "open-link-in-preview", target },
                    result.cause,
                  );
                }
              },
              openExternal: (target) => api.shell.openExternal(target),
              copyLink: (target) => writeTextToClipboard(target, "link"),
              updateThreadLink: updateThreadPullRequestLink,
              reportFailure: (operation, cause) => {
                reportMarkdownActionFailure({ operation, target: href }, cause);
                if (
                  operation === "link-pull-request-to-thread" ||
                  operation === "unlink-pull-request-from-thread"
                ) {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title:
                        operation === "link-pull-request-to-thread"
                          ? "Unable to link pull request"
                          : "Unable to unlink pull request",
                      description: cause instanceof Error ? cause.message : "The request failed.",
                    }),
                  );
                }
              },
            });
          }}
        >
          {faviconHost && hasText && !isPullRequestAutolink ? (
            <MarkdownExternalLinkContent host={faviconHost} plainText={plainHastText(node)}>
              {linkChildren}
            </MarkdownExternalLinkContent>
          ) : (
            linkChildren
          )}
        </a>
      );
      if (!faviconHost || !href) {
        return link;
      }
      if (pullRequestPreviewTarget !== null) {
        return (
          <PullRequestLinkPreview
            link={link}
            originalUrl={href}
            target={pullRequestPreviewTarget}
            confirmBeforeOpen={confirmBeforeOpen}
            onOpenPullRequest={(targetUrl) =>
              openChangeRequestLink(
                {
                  metaKey: false,
                  ctrlKey: false,
                  preventDefault: () => undefined,
                  stopPropagation: () => undefined,
                },
                targetUrl,
                undefined,
                environmentId ?? undefined,
              )
            }
            onOpenFallback={openDeferredMarkdownLink}
          />
        );
      }
      return (
        <Tooltip>
          <TooltipTrigger render={link} />
          <TooltipPopup side="top">{href}</TooltipPopup>
        </Tooltip>
      );
    }

    const label = nodeToPlainText(children);
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    const source = start !== undefined && end !== undefined ? text.slice(start, end) : "";
    const copyMarkdown =
      source.startsWith("[") && source.includes("](")
        ? source
        : `[${(label || fileLinkMeta.basename).replace(/[\\[\]]/g, "\\$&")}](${normalizedHref})`;
    const chip = fileLinkChip(fileLinkMeta, copyMarkdown, normalizedHref);
    return isMarkdownFileLinkLabel(label, normalizedHref) ? (
      chip
    ) : (
      <span data-markdown-copy={copyMarkdown}>
        {children} {chip}
      </span>
    );
  },
  code: function MarkdownCode({ node, children, className, ...props }) {
    const { cwd, imageBaseDir, inlineCodeFileLinkMetaByText, fileLinkChip, mathEnabled, inline } =
      use(ChatMarkdownRendererContext);
    const math = mathEnabled ? mathKind(className) : null;
    if (math) {
      return (
        <MarkdownMath
          tex={nodeToPlainText(children)}
          display={math === "display"}
          focusable={!inline}
        />
      );
    }
    if (node?.properties?.dataInlineCode != null) {
      const codeText = nodeToPlainText(children);
      const fileLinkMeta =
        inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
        resolveInlineCodeFileLinkMeta(codeText, cwd, imageBaseDir ?? cwd);
      if (fileLinkMeta) {
        return fileLinkChip(
          fileLinkMeta,
          `\`${codeText}\``,
          inlineCodeFilePathCandidate(codeText) ?? codeText.trim(),
        );
      }
    }
    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  },
  img: function MarkdownImage({ node, title, src, alt, ...props }) {
    const {
      expandMedia,
      cwd,
      environmentId,
      githubMedia,
      imageBaseDir,
      threadRef,
      workspaceMutationId,
      renderContextReference,
    } = use(ChatMarkdownRendererContext);
    const imageExpand = use(MarkdownLinkContext) ? undefined : expandMedia;
    const contextReference = typeof src === "string" ? parseComposerContextHref(src) : null;
    if (contextReference) {
      const label = alt || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label })
      ) : (
        <span>{label}</span>
      );
    }
    const localSrc = node?.properties?.dataLocalSrc;
    const markdownTitle = node?.properties?.dataMarkdownTitle;
    const standalone = node?.properties?.dataStandalone === true;
    const authoredSrc = typeof localSrc === "string" ? localSrc : src;
    const authoredTitle = typeof markdownTitle === "string" ? markdownTitle : title;
    const srcString =
      typeof authoredSrc === "string" ? normalizeMarkdownLinkDestination(authoredSrc) : "";
    const classifiedSrc =
      typeof localSrc === "string" ? srcString.replaceAll("\\", "/") : srcString;
    const altText = alt ?? "";
    const copyMarkdown = markdownImageCopy(altText, srcString, authoredTitle);
    const { className, style: _style, width, height, ...imageProps } = props;
    const authoredSizeStyle = authoredImageSizeStyle(width, height);
    const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd);
    const kind = mediaKindFromPath(classifiedSrc) ?? "image";
    const directUri = imageSource._tag === "Direct" ? imageSource.uri : null;
    const githubMediaUrl =
      directUri === null ? null : githubMediaFetchUrl(resolveProtocolRelativeMediaUrl(directUri));
    if (
      githubMedia &&
      cwd !== undefined &&
      environmentId !== null &&
      directUri !== null &&
      githubMediaUrl !== null
    ) {
      return (
        <ChatMarkdownAssetImage
          environmentId={environmentId}
          resource={{ _tag: "github-media", cwd, url: githubMediaUrl }}
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          originalUrl={resolveProtocolRelativeMediaUrl(directUri)}
          framed={false}
          fallbackSrc={githubMediaUrl}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "Direct") {
      const mediaSrc = resolveProtocolRelativeMediaUrl(imageSource.uri);
      const originalUrl =
        resolveExternalWebLinkHost(imageSource.uri) !== null ? imageSource.uri : undefined;
      const reference = mediaUrlReference(imageSource.uri);
      const actionsSource: MediaActionSource = {
        kind,
        name: altText || kind,
        src: mediaSrc,
        ...(reference ? { reference } : {}),
      };
      if (kind === "video") {
        return (
          <ChatMarkdownVideo
            src={mediaSrc}
            alt={altText}
            copyMarkdown={copyMarkdown}
            originalUrl={originalUrl}
            style={authoredSizeStyle}
            actionsSource={actionsSource}
          />
        );
      }
      return (
        <ChatMarkdownImage
          key={mediaSrc}
          src={mediaSrc}
          alt={altText}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          actionsSource={actionsSource}
          originalUrl={originalUrl}
          onImageExpand={imageExpand}
        />
      );
    }
    if (imageSource._tag === "WorkspaceFile" && threadRef) {
      return (
        <ChatMarkdownAssetImage
          environmentId={threadRef.environmentId}
          resource={{
            _tag: "media-file",
            threadId: threadRef.threadId,
            path: imageSource.path,
          }}
          alt={altText}
          kind={kind}
          copyMarkdown={copyMarkdown}
          srcFragment={markdownImageSourceFragment(classifiedSrc)}
          standalone={standalone}
          style={authoredSizeStyle}
          workspaceRoot={cwd}
          workspaceMutationId={workspaceMutationId}
          onImageExpand={imageExpand}
        />
      );
    }
    return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind={kind} />;
  },
  table: function MarkdownTableRenderer({ node: _node, ...props }) {
    return <MarkdownTable {...props} />;
  },
  details: function MarkdownDetailsRenderer({ node: _node, children, open: detailsOpen }) {
    return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const {
      resolvedTheme,
      diffThemeName,
      expandMedia,
      isStreaming,
      onRunShellCommand,
      inline,
      mathEnabled,
    } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }

    const language = extractFenceLanguage(codeBlock.className);
    if (
      mathEnabled &&
      language === "math" &&
      (!isStreaming ||
        mathKind(codeBlock.className) === "display" ||
        isClosedCodeFence(node, text, codeBlock.code))
    ) {
      return <MarkdownMath tex={codeBlock.code} display focusable={!inline} />;
    }
    const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
    const highlightedCode = (
      <RenderErrorBoundary
        resetKeys={[codeBlock.code, language, diffThemeName, isStreaming]}
        fallback={<pre {...props}>{children}</pre>}
      >
        <Suspense
          fallback={
            <pre {...props} className="invisible" aria-hidden>
              {children}
            </pre>
          }
        >
          <SuspenseShikiCodeBlock
            className={codeBlock.className}
            code={codeBlock.code}
            themeName={diffThemeName}
            isStreaming={isStreaming}
          />
        </Suspense>
      </RenderErrorBoundary>
    );
    if (language === "mermaid") {
      return (
        <MarkdownMermaidCodeBlock
          code={codeBlock.code}
          fenceTitle={fenceTitle}
          theme={resolvedTheme}
          isStreaming={isStreaming && !isClosedCodeFence(node, text, codeBlock.code)}
          onExpand={(src) => expandMedia({ images: [{ src, name: "Mermaid diagram" }], index: 0 })}
        >
          {highlightedCode}
        </MarkdownMermaidCodeBlock>
      );
    }
    return (
      <MarkdownCodeBlock
        code={codeBlock.code}
        language={language}
        fenceTitle={fenceTitle}
        theme={resolvedTheme}
        onRunShellCommand={
          onRunShellCommand && !isStreaming && isClosedCodeFence(node, text, codeBlock.code)
            ? onRunShellCommand
            : undefined
        }
        isStreaming={isStreaming}
      >
        {highlightedCode}
      </MarkdownCodeBlock>
    );
  },
} satisfies Components;

function ChatMarkdown({
  text,
  className,
  inline = false,
  lineBreaks = false,
  parseRawHtml = true,
  extraRemarkPlugins = EMPTY_REMARK_PLUGINS,
  ...props
}: ChatMarkdownProps) {
  const {
    componentState,
    handleCopy,
    markdownRef,
    markdownUrlTransform,
    localMediaPreview,
    closeLocalMediaPreview,
  } = useChatMarkdownState({ text, inline, ...props });
  const incrementalParsing =
    props.isStreaming === true &&
    extraRemarkPlugins.length === 0 &&
    /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
  const Root = inline ? "span" : "div";
  const bindMarkdownRef = (node: HTMLElement | null) => {
    markdownRef.current = node;
  };
  const remarkPlugins = [
    ...(lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS),
    ...extraRemarkPlugins,
    ...(incrementalParsing ? [createIncrementalMarkdownPlugin()] : []),
  ];
  if (componentState.mathEnabled)
    remarkPlugins.unshift([remarkMath, { singleDollarTextMath: true }]);

  return (
    <Root
      ref={bindMarkdownRef}
      className={cn(
        "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word]",
        !inline &&
          "text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)]",
        className,
      )}
      data-streaming={componentState.isStreaming ? "" : undefined}
      onCopy={handleCopy}
    >
      <ChatMarkdownRendererContext value={componentState}>
        <ChatMarkdownTextContext value={text}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={
              parseRawHtml
                ? CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS
                : CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS
            }
            skipHtml={false}
            components={CHAT_MARKDOWN_COMPONENTS}
            urlTransform={markdownUrlTransform}
          >
            {text}
          </ReactMarkdown>
        </ChatMarkdownTextContext>
      </ChatMarkdownRendererContext>
      {localMediaPreview ? (
        <ExpandedImageDialog preview={localMediaPreview} onClose={closeLocalMediaPreview} />
      ) : null}
    </Root>
  );
}

export default memo(ChatMarkdown);
