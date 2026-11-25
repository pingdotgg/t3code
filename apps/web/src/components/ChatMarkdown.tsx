import { m } from "../i18n/messages";
import { thrownErrorMessage } from "@lathe/client-runtime/errors";
import { msg, T, useGT, useMessages } from "gt-react";
import { resolvePathLinkTarget } from "@lathe/shared/fileLinks";
import { clientHostEnvironmentAtom } from "../state/clientHostEnvironment";
import { buildFileLinkParentSuffixByPath, fileLinkLabel } from "@lathe/shared/fileLinks";
import {
  isMarkdownFileLinkLabel,
  isWindowsDrivePathHref,
  shouldRenderMarkdownImageAsFileLink,
  normalizeMarkdownLinkDestination,
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
} from "@lathe/shared/markdownLinks";
import { taskListMarkerOffset } from "@lathe/shared/markdownTaskEdits";
import { isHostPath, resolveWorkspaceFilePath } from "@lathe/shared/path";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  SOURCE_CONTROL_MEDIA_ASSET,
} from "@lathe/contracts";
import { chatMarkdownImageSource } from "@lathe/shared/markdownHast";
import { useAtomValue } from "@effect/atom-react";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@lathe/shared/composerContextClipboard";
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
  StarIcon,
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
} from "@lathe/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lathe/client-runtime/state/runtime";
import { scopedThreadKey } from "@lathe/client-runtime/environment";
import type {
  CodexArtifactTemplate,
  CodexArtifactTemplateKind,
} from "@lathe/shared/codexArtifactTemplates";
import { codexArtifactTemplatePresentationLabel } from "@lathe/shared/codexArtifactTemplatesCopy";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@lathe/client-runtime/markdown-images";
import { mediaUrlReference } from "@lathe/client-runtime/media-reference";
import { mediaKindFromPath, mediaMimeTypeFromExtension } from "@lathe/shared/mediaPreview";
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
  use,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isDocumentCitation, parseCitationHref } from "@lathe/shared/assistantCitations";
import { parseComposerContextHref } from "@lathe/shared/composerContextReferences";
import { parseThreadLinkHref } from "@lathe/shared/threadLinks";
import { AssistantCitationEmbed } from "./chat/AssistantCitationChip";
import { DocumentCitationChip } from "./chat/DocumentCitationChip";
import { MarkdownThreadLink } from "./chat/MarkdownThreadLink";
import { artifactTemplateFromHastProperties } from "@lathe/shared/codexArtifactTemplates";
import {
  decodeMarkdownLinkEscapes,
  renderCodexInlineDirectivesAsMarkdown,
} from "../markdown/markdownText";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import { parseInlineCodeLanguage, type MarkdownDocumentSection } from "../markdown-document";
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
import { SharedTooltipProvider, SharedTooltipTrigger } from "./ui/shared-tooltip";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { recordVisitForThread } from "../browserHistoryStore";
import { contextMenuSourceOf, openContextMenuFromKeyboard } from "../contextMenuSource";
import {
  PreferredEditorEnvironmentRequiredError,
  useOpenInPreferredEditor,
  usePreferredEditor,
} from "../editorPreferences";
import { openInEditorMenuLabel } from "../editorLabels";
import { useDiffThemeName } from "../hooks/useDiffThemeName";
import { HighlightedTokens } from "./chat/HighlightedTokens";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { useRenderedAppearance } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
import {
  isLocalEditorFileHref,
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
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { hostEnvironmentIdAtom } from "../state/primaryEnvironment";
import { cn } from "../lib/utils";
import { resolveRemoteOpenState, useRemoteOpenResolution } from "../remoteOpen";
import { rightPanelHostRef, useRightPanelStore } from "../rightPanelStore";
import { useOpenIssueLink } from "../lib/openIssueLink";
import { issueTrackerEnvironment } from "../state/issueTrackers";
import { useEnvironmentQuery } from "../state/query";
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
  findAgentDirectoryMatch,
  needsWorkspaceBasenameLookup,
  pickProjectLinkMatch,
  pickWorkspaceLinkMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
  workspaceLinkLookupQuery,
} from "@lathe/client-runtime/workspace-basename-lookup";
import { resolvePullRequestPreviewTarget } from "@lathe/client-runtime/change-request-links";
import {
  mayContainStandaloneIssueLink,
  resolveIssueLinkTarget,
} from "@lathe/client-runtime/issue-links";
import { sourceControlClients } from "@lathe/client-runtime/source-control-clients";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { textDirection } from "~/textDirection";
import { useOpenLink } from "../browser/useOpenLink";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import {
  isBrowserPreviewFile,
  openFileInPreview,
  openUrlInPreview,
  BrowserPreviewUnavailableError,
  isBrowserSettingsReadError,
} from "../browser/openFileInPreview";
import { resolveLinkTarget } from "../browser/browserLinkTarget";
import { PullRequestLinkPreview } from "./pullRequest/PullRequestLinkPreview";
import { IssueLinkPreview, IssueLinkPreviewFallback } from "./issue/IssueLinkPreview";
import { MarkdownCodeBlock, SuspenseShikiCodeBlock } from "./chat/MarkdownCodeBlock";
import { createMarkdownRenderer } from "./chat/markdownRenderer";
import type { MarkdownExtensions, WordsHastOptions } from "../markdown/wordsHast";
import {
  type MarkdownIslandOptions,
  renderHastWithIslands,
  withProperties,
} from "./chat/markdownIslands";
import type { Element as HastElement, ElementContent, Root as HastRoot } from "hast";
import { matchInlineSkills } from "@lathe/shared/inlineSkills";
import { collectComposerModelMentions } from "@lathe/client-runtime/composer-model-mentions";
import { splitMarkdownBlocks } from "./chat/markdownStreamBlocks";
import { MermaidDiagram } from "./chat/MermaidDiagram";
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
import { githubHeadingSlug, handleMarkdownFragmentClick } from "./chat/markdownFragments";
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
  renderInsights?: boolean;
  /** Compact markdown transforms remove blocks before rendering inside a label. */
  inline?: boolean;
  text: string;
  cwd: string | undefined;
  /** Folders the agent worked in before writing `text`, the latest first; read when a link opens. */
  agentDirectories?: (() => ReadonlyArray<string>) | undefined;
  threadRef?: ScopedThreadRef | undefined;
  pullRequestPanelRef?: ScopedThreadRef | undefined;
  environmentId?: EnvironmentId | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  onRepairMermaid?: ((prompt: string) => void) | undefined;
  skills?: ReadonlyArray<ServerProviderSkill>;
  className?: string;
  lineBreaks?: boolean;
  parseRawHtml?: boolean;
  onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  onRunShellCommand?: ((command: string) => void) | undefined;
  imageBaseDir?: string | undefined;
  workspaceMutationId?: string | null | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  /** Keep one object per configuration (a module constant): it keys the shared parse cache. */
  extensions?: MarkdownExtensions | undefined;
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  /** Loads media a source control host keeps behind a credential through the server, which holds
      `cwd`'s; without it a private repository's uploads load unauthenticated and 404. */
  sourceControlMedia?: boolean | undefined;
  /** The change request's repository, when it can differ from the checkout at `cwd`. */
  sourceControlMediaRepository?: string | undefined;
  headingLevelOffset?: number | undefined;
  /** Render a standalone markdown file rather than a message: TeX math whatever the
      setting, GitHub heading anchors, source lines, and `code{:lang}` inline highlighting. */
  asDocument?: boolean | undefined;
  /** Where `text` sits in a long file rendered in sections, so source lines,
      heading anchors and task offsets read as the whole file's. */
  documentSection?: Omit<MarkdownDocumentSection, "text"> | undefined;
}

export interface ChatMarkdownContextReference {
  kind: string;
  contextId: string;
  label: string;
  /** Whether it starts or ends its block, for a reference that renders as a block. */
  leading?: boolean;
  trailing?: boolean;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const NO_EXTENSIONS: MarkdownExtensions = {};
const NO_PRECEDING_HEADINGS: ReadonlyArray<string> = [];

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
  const gt = useGT();
  const messages = useMessages();
  const Icon = ARTIFACT_TEMPLATE_ICON_BY_KIND[props.template.artifactKind];
  const presentationLabel = codexArtifactTemplatePresentationLabel(
    props.template.artifactKind,
    messages,
  );

  return (
    <div
      role="group"
      aria-label={gt("{name} template", { name: props.template.displayName })}
      dir={textDirection(props.template.displayName)}
      data-chat-markdown-artifact-template
      className="my-[0.65rem] flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-foreground shadow-xs"
      data-artifact-kind={props.template.artifactKind}
      data-markdown-copy={`${props.template.displayName} (${presentationLabel})\n\n`}
      data-skill-name={props.template.skillName}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground shadow-xs">
          <Icon aria-hidden className="size-5" />
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
          <T>Use template</T>
        </Button>
      ) : null}
    </div>
  );
}

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

function orderedListGutterStyle(
  itemValues: ReadonlyArray<unknown>,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  let number = Number.isNaN(parsedStart) ? 1 : parsedStart;
  let markerWidth = String(number).length;
  for (const value of itemValues) {
    const written = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isNaN(written)) number = written;
    markerWidth = Math.max(markerWidth, String(number).length);
    number += 1;
  }
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` };
}

const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
> = {
  insight: {
    label: msg("Insight"),
    Icon: StarIcon,
    borderClassName: "border-info",
    titleClassName: "text-info",
  },
  note: {
    label: msg("Note"),
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-blue-600 dark:text-blue-400",
  },
  tip: {
    label: msg("Tip"),
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    label: msg("Important"),
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: msg("Warning"),
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: msg("Caution"),
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

/** A component per element, with the hast node it renders, as react-markdown typed them. */
type MarkdownComponents = {
  [Tag in keyof React.JSX.IntrinsicElements]?: React.ComponentType<
    React.JSX.IntrinsicElements[Tag] & { node?: HastElement | undefined }
  >;
};

// react-markdown's defaultUrlTransform: relative URLs, and absolute ones with a safe protocol.
const SAFE_PROTOCOL = /^(?:https?|ircs?|mailto|xmpp)$/i;
function safeUrl(value: string): string {
  const colon = value.indexOf(":");
  const before = (character: string) => {
    const at = value.indexOf(character);
    return at !== -1 && colon > at;
  };
  return colon === -1 ||
    before("/") ||
    before("?") ||
    before("#") ||
    SAFE_PROTOCOL.test(value.slice(0, colon))
    ? value
    : "";
}

function markdownUrlTransform(href: string) {
  if (parseCitationHref(href)) return href;
  if (parseComposerContextHref(href)) return href;
  if (parseThreadLinkHref(href)) return href;
  if (isWindowsDrivePathHref(href)) return href;
  if (isLocalEditorFileHref(href)) return href;
  return rewriteMarkdownFileUriHref(href) ?? safeUrl(href);
}

const NO_MARKDOWN_EDITORS: ReadonlyArray<EditorId> = [];

type MarkdownServerConfigFields = ReturnType<typeof markdownServerConfigFields>;

function markdownServerConfigFields(config: ServerConfig | null) {
  return {
    pullRequestsEnabled: config !== null,
    issuesEnabled: config?.environment.capabilities.issues === true,
    isMacOS: config?.environment.platform.os === "darwin",
    availableEditors: config?.availableEditors ?? NO_MARKDOWN_EDITORS,
    revealInFileManager:
      config?.shellRevealInFileManager === true && config.availableEditors.includes("file-manager")
        ? (config.shellRevealInFileManagerKind ?? config.environment.platform.os)
        : undefined,
  };
}

function markdownServerConfigFieldsEqual(
  previous: MarkdownServerConfigFields,
  next: MarkdownServerConfigFields,
): boolean {
  return (
    previous.pullRequestsEnabled === next.pullRequestsEnabled &&
    previous.issuesEnabled === next.issuesEnabled &&
    previous.isMacOS === next.isMacOS &&
    previous.revealInFileManager === next.revealInFileManager &&
    previous.availableEditors.length === next.availableEditors.length &&
    previous.availableEditors.every((editor, index) => editor === next.availableEditors[index])
  );
}

// Compare only markdown config fields to avoid rerendering replies on every provider status push.
const markdownServerConfigFieldsAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => {
    const next = markdownServerConfigFields(get(serverEnvironment.configValueAtom(environmentId)));
    const previous = Option.getOrNull(get.self<MarkdownServerConfigFields>());
    return previous !== null && markdownServerConfigFieldsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("markdown-server-config-fields")),
);

interface BlockFileLinkSources {
  readonly hrefs: ReadonlyArray<string>;
  readonly spans: ReadonlyArray<string>;
}

function blockFileLinkSources(
  text: string,
  cwd: string | undefined,
  imageBaseDir: string | undefined,
): BlockFileLinkSources {
  const hrefs = extractMarkdownLinkHrefs(renderCodexInlineDirectivesAsMarkdown(text))
    .filter((href) => !parseComposerContextHref(href))
    .map(decodeMarkdownLinkEscapes)
    .map(normalizeMarkdownLinkHrefKey)
    .filter((href) => resolveMarkdownFileLinkMeta(href, cwd, imageBaseDir ?? cwd));
  const spans = extractInlineCodeSpans(text).filter((span) =>
    resolveInlineCodeFileLinkMeta(span, cwd, imageBaseDir ?? cwd),
  );
  return { hrefs, spans };
}

// Links and code spans never cross blocks: a streamed reply rescans only its open last block.
const MAX_CACHED_BLOCK_CHARS = 2_000_000;
const finishedBlockFileLinkSources = new Map<string, BlockFileLinkSources>();
let cachedBlockChars = 0;

function fileLinkSourcesKey(
  text: string,
  cwd: string | undefined,
  imageBaseDir: string | undefined,
  streamingBlocks: ReadonlyArray<string> | null,
): string {
  if (!streamingBlocks) {
    const { hrefs, spans } = blockFileLinkSources(text, cwd, imageBaseDir);
    return JSON.stringify([[...new Set(hrefs)], [...new Set(spans)]]);
  }
  const config = `${cwd ?? ""}\u0000${imageBaseDir ?? ""}\u0000`;
  const hrefs = new Set<string>();
  const spans = new Set<string>();
  const last = streamingBlocks.length - 1;
  for (const [index, block] of streamingBlocks.entries()) {
    // The last block still grows; caching each of its prefixes would only fill the cache.
    const key = config + block;
    let sources = index === last ? undefined : finishedBlockFileLinkSources.get(key);
    if (!sources) {
      sources = blockFileLinkSources(block, cwd, imageBaseDir);
      if (index !== last) {
        if (cachedBlockChars + key.length > MAX_CACHED_BLOCK_CHARS) {
          finishedBlockFileLinkSources.clear();
          cachedBlockChars = 0;
        }
        finishedBlockFileLinkSources.set(key, sources);
        cachedBlockChars += key.length;
      }
    }
    for (const href of sources.hrefs) hrefs.add(href);
    for (const span of sources.spans) spans.add(span);
  }
  return JSON.stringify([[...hrefs], [...spans]]);
}

function resolveFileLinkSources(
  key: string,
  cwd: string | undefined,
  imageBaseDir: string | undefined,
) {
  const [hrefs, spans] = JSON.parse(key) as [string[], string[]];
  const markdownFileLinkMetaByHref = new Map<string, MarkdownFileLinkMeta>();
  for (const href of hrefs) {
    const meta = resolveMarkdownFileLinkMeta(href, cwd, imageBaseDir ?? cwd);
    if (meta) markdownFileLinkMetaByHref.set(href, meta);
  }
  const inlineCodeFileLinkMetaByText = new Map<string, MarkdownFileLinkMeta>();
  for (const span of spans) {
    const meta = resolveInlineCodeFileLinkMeta(span, cwd, imageBaseDir ?? cwd);
    if (meta) inlineCodeFileLinkMetaByText.set(span, meta);
  }
  const fileLinkParentSuffixByPath = buildFileLinkParentSuffixByPath([
    ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
    ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
  ]);
  return { markdownFileLinkMetaByHref, inlineCodeFileLinkMetaByText, fileLinkParentSuffixByPath };
}

function useChatMarkdownState(
  {
    text,
    inline = false,
    cwd,
    agentDirectories,
    threadRef,
    pullRequestPanelRef,
    environmentId: explicitEnvironmentId,
    onTaskListChange,
    isStreaming = false,
    skills = EMPTY_MARKDOWN_SKILLS,
    onUseArtifactTemplate,
    onRepairMermaid,
    onRunShellCommand,
    imageBaseDir,
    workspaceMutationId,
    onImageExpand,
    renderContextReference,
    headingLevelOffset = 0,
    sourceControlMedia = false,
    asDocument = false,
    documentSection,
    sourceControlMediaRepository,
  }: ChatMarkdownProps,
  streamingBlocks: ReadonlyArray<string> | null,
) {
  const gt = useGT();
  const messages = useMessages();
  const resolvedTheme = useRenderedAppearance();
  const markdownRef = useRef<HTMLElement>(null);
  const mediaRequestId = useRef(0);
  const mediaScopeKey = [
    threadRef?.environmentId,
    threadRef?.threadId,
    explicitEnvironmentId,
    cwd,
    imageBaseDir,
  ].join("\u0000");
  // Hide requests from an old scope even if they resolve before effect cleanup.
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
  // Layout cleanup blocks stale requests from reaching onImageExpand before paint.
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- layout cleanup invalidates media requests still loading for the old scope before paint
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
  const isClientHost = useAtomValue(clientHostEnvironmentAtom(environmentId));
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
      // Read the connection on click; reconnect replaces it, and subscriptions would refresh every markdown
      // context.
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
          thrownErrorMessage(error, m) ??
          gt("The file could not be loaded. It may have been moved or deleted.");
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
              routes: [],
              remoteOpenTargets: undefined,
              isDesktopRenderer: window.desktopBridge !== undefined,
              hostEnvironmentId: appAtomRegistry.get(hostEnvironmentIdAtom),
            }).mode !== "local-exec"
          ) {
            description = gt("The file was not found on {machine} at {path}.", {
              machine: target.label,
              path: error.checkedPath ?? error.resource.path,
            });
          }
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Media unavailable"),
            description,
          }),
        );
      },
    );
  };
  const { pullRequestsEnabled, issuesEnabled, availableEditors, revealInFileManager, isMacOS } =
    useAtomValue(markdownServerConfigFieldsAtom(environmentId));
  const revealInFileManagerLabel =
    revealInFileManager === undefined
      ? undefined
      : revealInFileManager === "finder" ||
          revealInFileManager === "file-explorer" ||
          revealInFileManager === "files"
        ? revealInFileExplorerLabelForKind(revealInFileManager, messages)
        : revealInFileExplorerLabelForOs(revealInFileManager, messages);
  const projects = useProjects();
  const issueProjects = projects.filter((project) => project.environmentId === environmentId);
  // Only text naming a standalone tracker asks for its bindings, whose read probes the tracker.
  const issueTrackers =
    useEnvironmentQuery(
      issuesEnabled && environmentId !== null && mayContainStandaloneIssueLink(text)
        ? issueTrackerEnvironment.connections({ environmentId, input: {} })
        : null,
    ).data ?? undefined;
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const preferredEditorMenuLabel = openInEditorMenuLabel(preferredEditor, messages);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors, cwd);
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
          Cause.fail(new Error(gt("This connection cannot reveal files on this environment."))),
        ),
      );
    }
    return openInEditor({
      environmentId,
      input: { cwd: filePath, editor: "file-manager", reveal: true },
    });
  };
  const diffThemeName = useDiffThemeName();
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
  const openIssueLink = useOpenIssueLink(threadRef, pullRequestPanelRef);
  const openDeferredMarkdownLink = useOpenLink(threadRef);
  // Subscribe so hydrated settings apply before the anchor synchronously decides whether to intercept _blank.
  const linkTargetPreference = useClientSettings((settings) => settings.browserLinkTarget);
  // A markdown file always typesets its math, as on GitHub; chat math is a setting.
  const mathEnabled = useClientSettings((settings) => settings.mathRenderingEnabled) || asDocument;
  const documentLineOffset = (documentSection?.startLine ?? 1) - 1;
  const documentPrecedingHeadings = documentSection?.precedingHeadings ?? NO_PRECEDING_HEADINGS;
  // Keyed by the file links found, not the text, so streamed text that adds none keeps the
  // renderer context, and every block reading it, unchanged.
  // A template literal marks the key as a string, so the compiler memoizes the maps on its value.
  const fileLinksKey = `${fileLinkSourcesKey(text, cwd, imageBaseDir, isStreaming ? (streamingBlocks ?? splitMarkdownBlocks(text) ?? [text]) : null)}`;
  const { markdownFileLinkMetaByHref, inlineCodeFileLinkMetaByText, fileLinkParentSuffixByPath } =
    resolveFileLinkSources(fileLinksKey, cwd, imageBaseDir);
  const resolveThreadPullRequest = (
    href: string,
  ): (ThreadPullRequestKey & { readonly url: string }) | null => {
    if (
      threadRef === undefined ||
      readThreadShell(threadRef) === null ||
      !pullRequestLinking.canLink(href)
    )
      return null;
    const parsed = sourceControlClients.parseChangeRequestUrl(href)?.link;
    return parsed === undefined ? null : { ...parsed, url: href };
  };
  const linkedThreadPullRequestFor = (href: string) => {
    if (threadRef === undefined || !pullRequestLinking.isLinked(readThreadShell(threadRef), href))
      return null;
    const parsed = sourceControlClients.parseChangeRequestUrl(href)?.link;
    return parsed === undefined ? null : { ...parsed, url: href };
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
              message: gt("Preview access is unavailable for this client."),
            }),
          ),
        ),
      );
    }
    return openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
      if (result._tag === "Success") recordVisitForThread(threadRef, url);
      else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        if (isBrowserSettingsReadError(error)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: gt("Unable to open link in browser"),
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
              message: gt("Environment is not connected."),
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
    const query = workspaceLinkLookupQuery(workspaceRelativePath, cwd);
    if (query === null) return null;
    const basenameLookup = needsWorkspaceBasenameLookup(workspaceRelativePath);
    // Search can be truncated or still scanning, so it cannot rule out the literal
    // path. A path with a folder opens as written whenever it exists.
    if (!basenameLookup) {
      const metadata = await getFilesystemMetadata({
        environmentId,
        input: { paths: [resolveWorkspaceFilePath(workspaceRelativePath, cwd)] },
      });
      if (metadata._tag !== "Success" || metadata.value.entries[0] !== null) return null;
    }
    const searchRoot = async (root: string) => {
      const rootQuery = workspaceLinkLookupQuery(workspaceRelativePath, root);
      if (rootQuery === null) return { root, entries: [] };
      const result = await searchProjectEntries({
        environmentId,
        input: {
          cwd: root,
          query: rootQuery,
          limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
          kind: "file",
        },
      });
      return { root, entries: result._tag === "Success" ? result.value.entries : [] };
    };
    const own = await searchRoot(cwd);
    const ownMatch = pickWorkspaceLinkMatch(workspaceRelativePath, cwd, own.entries);
    if (ownMatch !== null) return ownMatch;
    const threadProjectId = threadRef ? readThreadShell(threadRef)?.projectId : undefined;
    const otherRoots = projects.flatMap((project) =>
      project.environmentId === environmentId &&
      project.id !== threadProjectId &&
      project.workspaceRoot !== cwd
        ? [project.workspaceRoot]
        : [],
    );
    const agentRoots = (agentDirectories?.() ?? []).filter((root) => root !== cwd);
    if (otherRoots.length === 0 && agentRoots.length === 0) return null;
    // Another project's file never replaces a thread-local file the search missed.
    if (basenameLookup) {
      const metadata = await getFilesystemMetadata({
        environmentId,
        input: { paths: [resolveWorkspaceFilePath(workspaceRelativePath, cwd)] },
      });
      if (metadata._tag !== "Success" || metadata.value.entries[0] !== null) return null;
    }
    const projectSearches = await Promise.all(otherRoots.map(searchRoot));
    const projectMatch = pickProjectLinkMatch(workspaceRelativePath, [own, ...projectSearches]);
    if (projectMatch !== null || agentRoots.length === 0) return projectMatch;
    // An unresolved project lookup falls back to the agent's working directories.
    const agentPaths = agentRoots.map((root) =>
      resolveWorkspaceFilePath(workspaceRelativePath, root),
    );
    const metadata = await getFilesystemMetadata({ environmentId, input: { paths: agentPaths } });
    if (metadata._tag !== "Success") return null;
    const literal = agentPaths.find((_, index) => metadata.value.entries[index]?.kind === "file");
    if (literal !== undefined || !basenameLookup) {
      return literal ?? null;
    }
    return findAgentDirectoryMatch(workspaceRelativePath, agentRoots, searchRoot);
  };
  const openFileInPanel = (fileLinkMeta: MarkdownFileLinkMeta, panelPath: string) => {
    if (!threadRef) return;
    // The panel reads relative paths from the thread's folder. A pull request body's `cwd` is the
    // checkout of its repository, which can be another folder.
    const shell = readThreadShell(threadRef);
    const panelRoot =
      shell?.worktreePath ??
      projects.find(
        (project) => project.environmentId === environmentId && project.id === shell?.projectId,
      )?.workspaceRoot;
    const openAt = (path: string) =>
      useRightPanelStore
        .getState()
        .openFile(
          threadRef,
          cwd && panelRoot !== undefined && cwd !== panelRoot
            ? resolveWorkspaceFilePath(path, cwd)
            : path,
          fileLinkMeta.line,
        );
    if (
      fileLinkMeta.workspaceLookupPath === null ||
      !cwd ||
      workspaceLinkLookupQuery(panelPath, cwd) === null
    ) {
      openAt(panelPath);
      return;
    }
    // Anything the user opens in this panel meanwhile, such as a file from the picker, wins.
    const panelRef = rightPanelHostRef(threadRef);
    const panelKey = scopedThreadKey(panelRef);
    const userActionRevision = useRightPanelStore.getState().markUserAction(panelRef);
    void (async () => {
      const match = await findWorkspaceFileMatch(fileLinkMeta);
      if (
        scopedThreadKey(rightPanelHostRef(threadRef)) !== panelKey ||
        useRightPanelStore.getState().getUserActionRevision(panelRef) !== userActionRevision
      )
        return;
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
    const isAppBundle = isMacOS && fileLinkMeta.filePath.endsWith(".app");
    const canOpenApp =
      environmentId !== null &&
      isAppBundle &&
      isClientHost &&
      canOperateHost &&
      availableEditors.includes("file-manager");
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
        iconPath={
          isAppBundle && cwd
            ? resolveWorkspaceFilePath(fileLinkMeta.filePath, cwd)
            : fileLinkMeta.filePath
        }
        isAppBundle={isAppBundle}
        workspaceRelativePath={fileLinkMeta.workspaceRelativePath}
        panelPath={isAppBundle ? null : panelPath}
        line={fileLinkMeta.line}
        label={fileLinkLabel(
          {
            path: fileLinkMeta.filePath,
            ...(fileLinkMeta.line !== undefined ? { line: fileLinkMeta.line } : {}),
            ...(fileLinkMeta.column !== undefined ? { column: fileLinkMeta.column } : {}),
            ...(fileLinkMeta.endLine !== undefined ? { endLine: fileLinkMeta.endLine } : {}),
          },
          fileLinkParentSuffixByPath,
        )}
        copyMarkdown={copyMarkdown}
        theme={resolvedTheme}
        threadRef={threadRef}
        onOpen={
          canOpenApp
            ? async () =>
                openInEditor({
                  environmentId,
                  input: { cwd: (await resolveHostPath()).absolutePath, editor: "file-manager" },
                })
            : canUseShellActions
              ? async () =>
                  openInPreferredEditor(
                    markdownFileEditorTarget(fileLinkMeta, await resolveHostPath()),
                  )
              : undefined
        }
        resolveDragPath={async () =>
          resolvePathLinkTarget((await resolveHostPath()).absolutePath, cwd ?? "")
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
        openInEditorMenuLabel={canOpenApp ? gt("Open app") : preferredEditorMenuLabel}
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
    asDocument,
    documentLineOffset,
    documentPrecedingHeadings,
    canOperateHost,
    canOperatePreview,
    cwd,
    diffThemeName,
    environmentId,
    expandMedia,
    fileLinkChip,
    sourceControlMedia,
    sourceControlMediaRepository,
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
    onRepairMermaid,
    onRunShellCommand,
    openChangeRequestLink,
    openIssueLink,
    openDeferredMarkdownLink,
    openExternalLinkInPreview,
    openMarkdownMedia,
    projects,
    issueProjects,
    issueTrackers,
    linkedThreadPullRequestFor,
    resolveThreadPullRequest,
    resolvedTheme,
    pullRequestsEnabled,
    issuesEnabled,
    skills,
    threadRef,
    updateThreadPullRequestLink,
  };
  return {
    componentState,
    handleCopy,
    markdownRef,
    localMediaPreview,
    closeLocalMediaPreview,
  };
}

const ChatMarkdownRendererContext = React.createContext<
  ReturnType<typeof useChatMarkdownState>["componentState"]
>(null!);

// Isolate streamed source text from the renderer context; only offset-based renderers need it.
const ChatMarkdownTextContext = React.createContext("");

// A quote card is a block. These say nothing else shares its paragraph or list item on that side.
const LIST_MARKER = String.raw`(?:[-*+]|\d+[.)])[ \t]+`;
const CITATION_LEADS_BLOCK = new RegExp(
  String.raw`(?:(?:^|\n[ \t]*\n)[ \t>]*(?:${LIST_MARKER})?|\n[ \t>]*${LIST_MARKER})$`,
);
const CITATION_ENDS_BLOCK = new RegExp(
  String.raw`^[ \t]*(?:$|\n[ \t]*(?:\n|$)|\n[ \t>]*${LIST_MARKER})`,
);

function markdownHeadingRenderer(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({
    node: _node,
    ...props
  }: ComponentProps<typeof Tag> & { node?: HastElement | undefined }) {
    const { headingLevelOffset } = use(ChatMarkdownRendererContext);
    return (
      <Tag
        {...props}
        aria-level={headingLevelOffset > 0 ? Math.min(level + headingLevelOffset, 6) : undefined}
      />
    );
  };
}

/** Inline code with a `{:lang}` marker, colored in place of its plain chip. */
function InlineShikiCode({ code, language }: { code: string; language: string }) {
  return (
    <code data-chat-markdown-inline-shiki>
      <HighlightedTokens code={code} language={language} />
    </code>
  );
}

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
    const { skills, threadRef, environmentId } = use(ChatMarkdownRendererContext);
    return (
      <p {...props}>
        {renderSkillInlineMarkdownChildren(children, skills, threadRef, environmentId)}
      </p>
    );
  },
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const m = useMessages();
    const alertKind = String((props as Record<string, unknown>)["data-alert"] ?? "");
    const alert = GITHUB_ALERT_PRESENTATIONS[alertKind];
    if (!alert) {
      return <blockquote {...props}>{children}</blockquote>;
    }
    return (
      <div
        role="note"
        data-markdown-alert={alertKind}
        dir={props.dir}
        className={cn("my-1 border-s-2 ps-3", alert.borderClassName)}
      >
        <p
          data-thread-find-ignore="true"
          data-markdown-alert-label=""
          className={cn("flex items-center gap-1.5 font-medium", alert.titleClassName)}
        >
          <alert.Icon aria-hidden className="size-3.5 shrink-0" />
          {m(alert.label)}
        </p>
        {children}
      </div>
    );
  },
  ol: function MarkdownOrderedList({ node, start, style, ...props }) {
    const itemValues =
      node?.children?.flatMap((child) =>
        child.type === "element" && child.tagName === "li" ? [child.properties.value] : [],
      ) ?? [];
    const gutterStyle = orderedListGutterStyle(itemValues, start);
    return (
      <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
    );
  },
  li: function MarkdownListItem({ node, children, ...props }) {
    const { skills, threadRef, environmentId } = use(ChatMarkdownRendererContext);
    // Resolve checkbox markers by offset to avoid rerendering list items on every streamed token.
    const isTaskItem = String(props.className ?? "").includes("task-list-item");
    return (
      <li {...props} data-list-item-offset={isTaskItem ? node?.position?.start.offset : undefined}>
        {renderSkillInlineMarkdownChildren(children, skills, threadRef, environmentId)}
      </li>
    );
  },
  input: function MarkdownInput({ node: _node, type, checked, disabled: _disabled, ...props }) {
    const gt = useGT();
    const { onTaskListChange } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    if (type !== "checkbox" || !onTaskListChange) {
      return (
        <input
          {...props}
          type={type}
          checked={type === "checkbox" ? checked === true : checked}
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
        aria-label={gt("Toggle task")}
        checked={checked === true}
        onChange={(event) => {
          const listItemStart = Number(event.currentTarget.closest("li")?.dataset.listItemOffset);
          if (!Number.isSafeInteger(listItemStart)) return;
          const markerOffset = taskListMarkerOffset(text, listItemStart);
          if (markerOffset === null) return;
          onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
        }}
      />
    );
  },
  a: function MarkdownAnchor({ node, href, children, title: _title, ...props }) {
    const gt = useGT();
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
      openIssueLink,
      openDeferredMarkdownLink,
      linkTargetPreference,
      openExternalLinkInPreview,
      projects,
      issueProjects,
      issueTrackers,
      linkedThreadPullRequestFor,
      resolveThreadPullRequest,
      pullRequestsEnabled,
      issuesEnabled,
      updateThreadPullRequestLink,
      fileLinkChip,
      renderContextReference,
    } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    const citation = href ? parseCitationHref(href) : null;
    if (citation && isDocumentCitation(citation))
      return <DocumentCitationChip citation={citation} />;
    const before = node?.position?.start.offset;
    const after = node?.position?.end.offset;
    const leading = before !== undefined && CITATION_LEADS_BLOCK.test(text.slice(0, before));
    const trailing = after !== undefined && CITATION_ENDS_BLOCK.test(text.slice(after));
    if (citation) {
      return <AssistantCitationEmbed citation={citation} leading={leading} trailing={trailing} />;
    }
    const threadLink = href ? parseThreadLinkHref(href) : null;
    if (threadLink) {
      const written = hastPlainTextDeep(node);
      // An autolink's text is its own URL, which is no label.
      const label = written && parseThreadLinkHref(written) === null ? written : null;
      return environmentId ? (
        <MarkdownThreadLink
          environmentId={environmentId}
          threadRef={threadRef}
          link={threadLink}
          label={label}
        />
      ) : (
        <span>{label ?? gt("Thread")}</span>
      );
    }
    const contextReference = href ? parseComposerContextHref(href) : null;
    if (contextReference) {
      const label = hastPlainTextDeep(node) || contextReference.contextId;
      return renderContextReference ? (
        renderContextReference({ ...contextReference, label, leading, trailing })
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
          ? /\/commit\/([0-9a-f]{7,40})$/iu.exec(href ?? "")?.[1]
          : pullRequestAutolink === "reference" || pullRequestAutolink === "mention"
            ? plainHastText(node)
            : undefined;
      const isPullRequestAutolink = pullRequestCopy !== undefined;
      const confirmBeforeOpen = pullRequestAutolink === "reference";
      const pullRequestCandidateUrl =
        confirmBeforeOpen && href
          ? sourceControlClients.changeRequestUrlFromReferenceAutolink(href)
          : href;
      const pullRequestPreviewTarget = pullRequestCandidateUrl
        ? resolvePullRequestPreviewTarget({
            environmentId,
            projects,
            pullRequestsEnabled,
            url: pullRequestCandidateUrl,
          })
        : null;
      const issueTarget =
        issuesEnabled && environmentId !== null && href
          ? resolveIssueLinkTarget({
              url: href,
              projects: issueProjects,
              trackers: issueTrackers,
            })
          : null;
      const issuePreviewTarget =
        issueTarget === null || environmentId === null
          ? null
          : { environmentId, input: issueTarget.ref };
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
              mediaKindFromPath(href) !== "audio" &&
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
              openChangeRequestLink(event, href, undefined, environmentId ?? undefined) ||
              openIssueLink(event, href, environmentId ?? undefined, issueTrackers)
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
              // Open desktop Alt-clicks before Chromium downloads them so link routers can read the held key.
              // Editor links also go over IPC: the desktop popup handler only passes web links.
              if (isElectron && (event.altKey || isLocalEditorFileHref(href))) {
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
              if (isBrowserSettingsReadError(squashAtomCommandFailure(result))) return;
              void readLocalApi()?.shell.openExternal(href);
            });
          }}
          onAuxClick={(event) => {
            // A middle-click raises no click event, and the desktop popup handler only passes web links.
            if (!isElectron || event.button !== 1 || !href || !isLocalEditorFileHref(href)) return;
            event.preventDefault();
            void readLocalApi()
              ?.shell.openExternal(href)
              .catch((cause) =>
                reportMarkdownActionFailure(
                  { operation: "open-link-external", target: href },
                  cause,
                ),
              );
          }}
          onKeyDown={(event) => {
            if (href && faviconHost) openContextMenuFromKeyboard(event);
          }}
          onContextMenu={(event) => {
            if (!href || !faviconHost) return;
            event.preventDefault();
            event.stopPropagation();
            const api = readLocalApi();
            if (!api) return;
            const source = contextMenuSourceOf(event);
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
              showContextMenu: (items, position) => api.contextMenu.show(items, position, source),
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
              copyLink: (target) =>
                writeTextToClipboard(target, {
                  target: "link",
                  unavailableMessage: msg("Clipboard API is unavailable while copying link."),
                  failureMessage: msg("Failed to copy link to the clipboard."),
                }),
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
                          ? gt("Unable to link pull request")
                          : gt("Unable to unlink pull request"),
                      description: thrownErrorMessage(cause, m) ?? gt("The request failed."),
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
            // A reference that is not a pull request may still be an issue this app can show.
            onOpenFallback={async (url) => {
              const opened = openIssueLink(
                {
                  metaKey: false,
                  ctrlKey: false,
                  preventDefault: () => undefined,
                  stopPropagation: () => undefined,
                },
                url,
                environmentId ?? undefined,
                issueTrackers,
              );
              if (!opened) await openDeferredMarkdownLink(url);
            }}
            fallback={
              issuePreviewTarget === null ? undefined : (
                <IssueLinkPreviewFallback originalUrl={href} target={issuePreviewTarget} />
              )
            }
          />
        );
      }
      if (issuePreviewTarget !== null) {
        return <IssueLinkPreview link={link} originalUrl={href} target={issuePreviewTarget} />;
      }
      return <SharedTooltipTrigger render={link} label={href} />;
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
        <span className="whitespace-normal">{children} </span>
        {chip}
      </span>
    );
  },
  code: function MarkdownCode({ node, children, className, ...props }) {
    const {
      asDocument,
      cwd,
      diffThemeName,
      imageBaseDir,
      inlineCodeFileLinkMetaByText,
      fileLinkChip,
    } = use(ChatMarkdownRendererContext);
    if (node?.properties?.dataInlineCode != null) {
      const codeText = nodeToPlainText(children);
      const inlineLanguage = asDocument ? parseInlineCodeLanguage(codeText) : null;
      if (inlineLanguage) {
        return (
          <RenderErrorBoundary
            resetKeys={[codeText, diffThemeName]}
            fallback={<code>{codeText}</code>}
          >
            <Suspense fallback={<code>{inlineLanguage.code}</code>}>
              <InlineShikiCode code={inlineLanguage.code} language={inlineLanguage.language} />
            </Suspense>
          </RenderErrorBoundary>
        );
      }
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
      return (
        <code {...props} className={className}>
          {children}
        </code>
      );
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
      sourceControlMedia,
      sourceControlMediaRepository,
      imageBaseDir,
      threadRef,
      workspaceMutationId,
      renderContextReference,
      fileLinkChip,
      resolvedTheme,
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
    const { authoredSrc: srcString = "", classifiedSrc = "" } =
      chatMarkdownImageSource(node?.properties ?? { src }, resolvedTheme) ?? {};
    const markdownTitle = node?.properties?.dataMarkdownTitle;
    const standalone = node?.properties?.dataStandalone === true;
    const authoredTitle = typeof markdownTitle === "string" ? markdownTitle : title;
    const altText = alt ?? "";
    const copyMarkdown = markdownImageCopy(altText, srcString, authoredTitle);
    const { className, style: _style, width, height, ...imageProps } = props;
    const authoredSizeStyle = authoredImageSizeStyle(width, height);
    const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd);
    const mediaKind = mediaKindFromPath(classifiedSrc);
    if (mediaKind === "audio") {
      const filePath = imageSource._tag === "WorkspaceFile" ? imageSource.path : null;
      const name =
        (filePath ?? classifiedSrc.split(/[?#]/, 1)[0] ?? "").split(/[\\/]/).at(-1) ||
        altText ||
        "Audio";
      if (imageSource._tag !== "Direct" && !(filePath && threadRef)) {
        return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind="audio" />;
      }
      return (
        <InlineAudioPreview
          key={classifiedSrc}
          name={name}
          copyMarkdown={copyMarkdown}
          {...(filePath && threadRef
            ? {
                environmentId: threadRef.environmentId,
                resource: {
                  _tag: "media-file" as const,
                  threadId: threadRef.threadId,
                  path: filePath,
                },
                onOpen: () => useRightPanelStore.getState().openFile(threadRef, filePath),
              }
            : imageSource._tag === "Direct"
              ? { src: resolveProtocolRelativeMediaUrl(imageSource.uri) }
              : {})}
        />
      );
    }
    if (shouldRenderMarkdownImageAsFileLink(imageSource, mediaKind)) {
      const fileLinkMeta = resolveMarkdownFileLinkMeta(srcString, cwd, imageBaseDir ?? cwd);
      if (fileLinkMeta) return fileLinkChip(fileLinkMeta, copyMarkdown, srcString);
    }
    const kind = mediaKind ?? "image";
    const directUri = imageSource._tag === "Direct" ? imageSource.uri : null;
    const hostMediaUrl =
      directUri === null
        ? null
        : (sourceControlClients.mediaUrl(resolveProtocolRelativeMediaUrl(directUri))?.fetchUrl ??
          null);
    if (
      sourceControlMedia &&
      cwd !== undefined &&
      environmentId !== null &&
      directUri !== null &&
      hostMediaUrl !== null
    ) {
      return (
        <ChatMarkdownAssetImage
          environmentId={environmentId}
          resource={{
            _tag: SOURCE_CONTROL_MEDIA_ASSET,
            cwd,
            url: hostMediaUrl,
            ...(sourceControlMediaRepository ? { repository: sourceControlMediaRepository } : {}),
          }}
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
          fallbackSrc={hostMediaUrl}
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
    const hostImageUrl = use(HostImageUrlContext);
    if (imageSource._tag === "WorkspaceFile" && kind === "image" && hostImageUrl !== null) {
      const hostSrc = hostImageUrl(imageSource.path);
      return (
        <ChatMarkdownImage
          key={hostSrc}
          src={hostSrc}
          alt={altText}
          copyMarkdown={copyMarkdown}
          standalone={standalone}
          className={className}
          style={authoredSizeStyle}
          imageProps={imageProps}
          actionsSource={{ kind, name: altText || kind, src: hostSrc }}
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
            ...(imageSource.relative ? { hostOnly: true as const } : {}),
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
  details: function MarkdownDetailsRenderer({ node: _node, children, open: detailsOpen, dir }) {
    return (
      <MarkdownDetails open={detailsOpen} dir={dir}>
        {children}
      </MarkdownDetails>
    );
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const { resolvedTheme, diffThemeName, isStreaming, onRepairMermaid, onRunShellCommand } = use(
      ChatMarkdownRendererContext,
    );
    const text = use(ChatMarkdownTextContext);
    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }

    // Drawn blocks replace the `pre`, so a layout-free wrapper carries the source lines a
    // document stamps on it.
    const sourceStart = node?.properties.dataSourceStart;
    const sourceEnd = node?.properties.dataSourceEnd;
    const sourceLined = (block: ReactNode) =>
      sourceStart == null ? (
        block
      ) : (
        <div className="contents" data-source-start={sourceStart} data-source-end={sourceEnd}>
          {block}
        </div>
      );
    const language = extractFenceLanguage(codeBlock.className);
    if (language?.toLowerCase() === "mermaid") {
      return sourceLined(
        <MermaidDiagram
          source={codeBlock.code.replace(/\n$/, "")}
          theme={resolvedTheme}
          pending={isStreaming && !isClosedCodeFence(node, text, codeBlock.code)}
          onRepair={onRepairMermaid}
        />,
      );
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
    return sourceLined(
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
      </MarkdownCodeBlock>,
    );
  },
} satisfies MarkdownComponents;

const markdownOptions = new WeakMap<MarkdownExtensions, Map<string, WordsHastOptions>>();

/** One options object per configuration, so equal messages share a renderer and its cache. */
function wordsOptions(
  extensions: MarkdownExtensions,
  flags: Omit<WordsHastOptions, "extensions">,
): WordsHastOptions {
  let byFlags = markdownOptions.get(extensions);
  if (!byFlags) markdownOptions.set(extensions, (byFlags = new Map()));
  const key = `${+flags.math}${+flags.breaks}${+flags.escapeHtml}${+flags.insights}`;
  let options = byFlags.get(key);
  if (!options) byFlags.set(key, (options = { ...flags, extensions }));
  return options;
}

const markdownRenderers = new WeakMap<
  WordsHastOptions,
  ReturnType<typeof createMarkdownRenderer>
>();

function markdownRenderer(markdown: WordsHastOptions) {
  let renderer = markdownRenderers.get(markdown);
  if (!renderer) {
    renderer = createMarkdownRenderer({
      markdown,
      components: CHAT_MARKDOWN_COMPONENTS,
      urlTransform: markdownUrlTransform,
    });
    markdownRenderers.set(markdown, renderer);
  }
  return renderer;
}

type ChatMarkdownComponentState = ReturnType<typeof useChatMarkdownState>["componentState"];

function hastClassName(node: HastElement): string | undefined {
  const { className } = node.properties;
  return Array.isArray(className) ? className.join(" ") : (className as string | undefined);
}

// Paragraphs and list items turn skill and model mentions in their text into chips, except in
// code and links, as SkillInlineText does.
function hastTextHasChip(node: HastElement, skills: ReadonlyArray<ServerProviderSkill>): boolean {
  return node.children.some((child) =>
    child.type === "text"
      ? (skills.length > 0 && !matchInlineSkills(child.value, skills).next().done) ||
        collectComposerModelMentions(child.value).length > 0
      : child.type === "element" &&
        child.tagName !== "code" &&
        child.tagName !== "a" &&
        hastTextHasChip(child, skills),
  );
}

const HEADING_LEVELS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

const markdownIslandOptionsByState = new WeakMap<
  ChatMarkdownComponentState,
  MarkdownIslandOptions
>();

/** Which elements need CHAT_MARKDOWN_COMPONENTS, and what the others' components add. */
function markdownIslandOptions(state: ChatMarkdownComponentState): MarkdownIslandOptions {
  const cached = markdownIslandOptionsByState.get(state);
  if (cached) return cached;
  const {
    asDocument,
    cwd,
    headingLevelOffset,
    imageBaseDir,
    inlineCodeFileLinkMetaByText,
    onTaskListChange,
    skills,
  } = state;
  const options: MarkdownIslandOptions = {
    components: CHAT_MARKDOWN_COMPONENTS,
    variant: String(headingLevelOffset),
    isIsland: (node) => {
      switch (node.tagName) {
        case "a":
        case "img":
        case "pre":
        case "details":
        case "table":
          return true;
        case "blockquote":
          return GITHUB_ALERT_PRESENTATIONS[String(node.properties.dataAlert ?? "")] !== undefined;
        case "div":
          return artifactTemplateFromHastProperties(node.properties) !== null;
        case "input":
          return node.properties.type === "checkbox" && onTaskListChange !== undefined;
        case "code": {
          if (node.properties.dataInlineCode == null) return false;
          const codeText = hastPlainTextDeep(node);
          return (
            (asDocument && parseInlineCodeLanguage(codeText) !== null) ||
            (inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
              resolveInlineCodeFileLinkMeta(codeText, cwd, imageBaseDir ?? cwd)) != null
          );
        }
        case "p":
        case "li":
          return hastTextHasChip(node, skills);
        default:
          return false;
      }
    },
    staticElement: (node) => {
      const level = HEADING_LEVELS[node.tagName];
      if (level !== undefined) {
        return headingLevelOffset > 0
          ? withProperties(node, { ariaLevel: Math.min(level + headingLevelOffset, 6) })
          : node;
      }
      switch (node.tagName) {
        case "ol": {
          const itemValues = node.children.flatMap((child) =>
            child.type === "element" && child.tagName === "li" ? [child.properties.value] : [],
          );
          const gutter = orderedListGutterStyle(itemValues, node.properties.start);
          if (!gutter) return node;
          const authored = typeof node.properties.style === "string" ? node.properties.style : "";
          return withProperties(node, {
            style: `${authored}${authored ? ";" : ""}--list-gutter:${gutter["--list-gutter"]}`,
          });
        }
        case "li":
          return hastClassName(node)?.includes("task-list-item")
            ? withProperties(node, { dataListItemOffset: node.position?.start.offset })
            : node;
        case "input":
          return node.properties.type === "checkbox"
            ? withProperties(node, { readOnly: true })
            : node;
        default:
          return node;
      }
    },
  };
  markdownIslandOptionsByState.set(state, options);
  return options;
}

/** One-based, inclusive lines of a document's source. */
interface SourceLines {
  readonly start: number;
  readonly end: number;
}

// The blocks a document quote names by line.
const SOURCE_LINE_BLOCKS = new Set([
  "blockquote",
  "dd",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "pre",
  "table",
  "td",
  "th",
  "tr",
]);

const ATX_HEADING_LINE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const TABLE_DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const LINK_DEFINITION_LINE = /^ {0,3}\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*\S/;
// A comment on one line renders nothing.
const HTML_COMMENT_LINE = /^ {0,3}<!--(?!-?>)(?:(?!-->).)*-->[ \t]*$/;
// A line led by an inline tag with text after it starts a paragraph, not an HTML block.
const INLINE_HTML_LINE =
  /^ {0,3}<(?:a|abbr|b|br|code|em|i|img|kbd|mark|s|small|span|strong|sub|sup|u)\b[^<>]*>[ \t]*\S/i;
// CommonMark's HTML blocks that end a paragraph (its kinds 1 to 6); any other tag continues it.
const HTML_BLOCK_LINE =
  /^ {0,3}<(?:!--|\?|![A-Za-z]|!\[CDATA\[|(?:pre|script|style|textarea)(?:[\s>]|$)|\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s>]|\/>|$))/i;

interface SourceSegment {
  kind: "heading" | "rule" | "quote" | "table" | "text" | "unknown";
  start: number;
  end: number;
}

const SEGMENT_TAGS: Record<SourceSegment["kind"], RegExp> = {
  heading: /^h[1-6]$/,
  rule: /^hr$/,
  quote: /^blockquote$/,
  table: /^table$/,
  text: /^p$/,
  unknown: /^$/,
};

/**
 * The blocks written on lines `from` to `to`, none of which is a list or code: Words positions
 * those itself. Raw HTML and footnotes are `unknown`, as the text does not say how many blocks
 * they render, or where.
 */
function sourceSegments(lines: ReadonlyArray<string>, from: number, to: number): SourceSegment[] {
  const segments: SourceSegment[] = [];
  let open: SourceSegment | null = null;
  const begin = (kind: SourceSegment["kind"], line: number): SourceSegment => {
    const segment: SourceSegment = { kind, start: line, end: line };
    segments.push(segment);
    return segment;
  };
  for (let number = from; number <= to; number++) {
    const line = lines[number - 1]!;
    if (line.trim() === "") {
      open = null;
    } else if (open?.kind === "unknown") {
      open.end = number;
    } else if (HTML_COMMENT_LINE.test(line)) {
      open = null;
    } else if (
      /^ {0,3}</.test(line) &&
      (open === null ? !INLINE_HTML_LINE.test(line) : HTML_BLOCK_LINE.test(line))
    ) {
      open = begin("unknown", number);
    } else if (ATX_HEADING_LINE.test(line)) {
      begin("heading", number);
      open = null;
    } else if (open?.kind === "text" && SETEXT_UNDERLINE.test(line)) {
      open.kind = "heading";
      open.end = number;
      open = null;
    } else if (THEMATIC_BREAK.test(line)) {
      begin("rule", number);
      open = null;
    } else if (/^ {0,3}>/.test(line)) {
      if (open?.kind === "quote") open.end = number;
      else open = begin("quote", number);
    } else if (open === null) {
      // A link definition renders nothing; a footnote's text renders at the end of the document.
      if (LINK_DEFINITION_LINE.test(line)) continue;
      open = begin(/^ {0,3}\[\^/.test(line) ? "unknown" : "text", number);
    } else if (open.kind === "text" && line.includes("|") && TABLE_DELIMITER_ROW.test(line)) {
      // The line before the delimiter row is the header; any lines before that are a paragraph.
      if (open.end > open.start) {
        open.end = number - 2;
        open = begin("table", number - 1);
      } else {
        open.kind = "table";
      }
      open.end = number;
    } else {
      open.end = number;
    }
  }
  return segments;
}

/** The first words of a block's text, which the lines it was written on also hold. */
function leadingWords(node: HastElement): string[] {
  for (const child of node.children) {
    if (child.type === "text") {
      const words = child.value.match(/[\p{L}\p{N}]{2,}/gu);
      if (words) return words.slice(0, 3);
    } else if (child.type === "element" && child.tagName !== "svg") {
      const words = leadingWords(child);
      if (words.length > 0) return words;
    }
  }
  return [];
}

/**
 * The source lines of a rendered document's blocks. Words positions only list items, code and
 * math, so the blocks between those are matched, in order and from both ends, to the blocks
 * written on the lines between. A block that matches neither way takes all the lines left over.
 */
function documentSourceLines(tree: HastRoot, text: string): Map<HastElement, SourceLines> {
  const lines: string[] = [];
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (at: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= at) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const positioned = (node: HastElement): SourceLines | null => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return null;
    return { start: lineAt(start), end: lineAt(Math.max(start, end - 1)) };
  };
  // Footnotes render at the end of the document, wherever they were written.
  const elements = (node: HastRoot | HastElement) =>
    (node.children as ElementContent[]).filter(
      (child): child is HastElement =>
        child.type === "element" &&
        !(child.tagName === "section" && child.properties.dataFootnotes !== undefined),
    );

  /** What is known of an element's extent, whatever its tag. */
  const known = new Map<HastElement, SourceLines>();
  const findPositioned = (node: HastRoot | HastElement) => {
    for (const child of elements(node)) {
      if (child.tagName === "li" || child.tagName === "pre") {
        const span = positioned(child);
        if (span) known.set(child, span);
      }
      findPositioned(child);
    }
  };
  findPositioned(tree);

  /** A top-level block Words positions whole: code, a list by its items, display math. */
  const anchor = (block: HastElement): SourceLines | null => {
    if (block.tagName === "pre") return known.get(block) ?? null;
    if (block.tagName === "ul" || block.tagName === "ol") {
      const items = elements(block).map((item) => known.get(item));
      const first = items[0];
      const last = items.at(-1);
      return first && last && !items.includes(undefined)
        ? { start: first.start, end: last.end }
        : null;
    }
    if (block.properties.dataMarkdownMath === "display") {
      const drawn = elements(block)[0];
      return drawn ? positioned(drawn) : null;
    }
    return null;
  };
  /** The extent of what Words positions inside a block, which the block's own lines cover. */
  const within = (node: HastElement): SourceLines | null => {
    let span = positioned(node);
    for (const child of elements(node)) {
      const inner = within(child);
      if (!inner) continue;
      span = span
        ? { start: Math.min(span.start, inner.start), end: Math.max(span.end, inner.end) }
        : inner;
    }
    return span;
  };
  /** Whether `block` can be what `segment`'s lines render: its tag, its text and what it holds. */
  const renders = (segment: SourceSegment, block: HastElement): boolean => {
    if (!SEGMENT_TAGS[segment.kind].test(block.tagName)) return false;
    const inner = within(block);
    if (inner && (inner.start < segment.start || inner.end > segment.end)) return false;
    const source = lines.slice(segment.start - 1, segment.end).join("\n");
    let at = 0;
    for (const word of leadingWords(block)) {
      const found = source.indexOf(word, at);
      if (found < 0) return false;
      at = found + word.length;
    }
    return true;
  };
  const place = (block: HastElement, { start, end }: SourceSegment) => {
    known.set(block, { start, end });
    if (block.tagName !== "table") return;
    const rows = elements(block).flatMap((section) =>
      section.tagName === "tr" ? [section] : elements(section),
    );
    // A header row, the delimiter row, then one line for each body row.
    if (rows.length !== end - start) return;
    for (const [index, row] of rows.entries()) {
      const line = start + (index === 0 ? 0 : index + 1);
      known.set(row, { start: line, end: line });
    }
  };
  /** Blocks between two anchors, matched to what lines `from` to `to` write. */
  const placeRun = (run: ReadonlyArray<HastElement>, from: number, to: number) => {
    if (run.length === 0) return;
    const segments = sourceSegments(lines, from, to);
    const pairs = Math.min(run.length, segments.length);
    let head = 0;
    while (head < pairs && renders(segments[head]!, run[head]!)) head++;
    let tail = 0;
    while (tail < pairs - head && renders(segments.at(-1 - tail)!, run.at(-1 - tail)!)) tail++;
    for (let index = 0; index < head; index++) place(run[index]!, segments[index]!);
    for (let index = 1; index <= tail; index++) place(run.at(-index)!, segments.at(-index)!);
    // What matched neither way shares the lines left between: raw HTML, or blocks out of step.
    let start = head > 0 ? segments[head - 1]!.end + 1 : from;
    let end = tail > 0 ? segments.at(-tail)!.start - 1 : to;
    while (start <= end && lines[start - 1]!.trim() === "") start++;
    while (end >= start && lines[end - 1]!.trim() === "") end--;
    if (start > end) return;
    for (const block of run.slice(head, run.length - tail)) known.set(block, { start, end });
  };

  let from = 1;
  let run: HastElement[] = [];
  for (const block of elements(tree)) {
    const span = anchor(block);
    if (!span) {
      run.push(block);
      continue;
    }
    placeRun(run, from, span.start - 1);
    run = [];
    from = span.end + 1;
    if (block.tagName !== "ul" && block.tagName !== "ol") known.set(block, span);
  }
  placeRun(run, from, lines.length);

  // A block inside another takes the lines of the nearest block around it that has some.
  const stamped = new Map<HastElement, SourceLines>();
  const spread = (node: HastRoot | HastElement, nearest: SourceLines | undefined) => {
    for (const child of elements(node)) {
      const span = known.get(child) ?? nearest;
      if (
        span &&
        (SOURCE_LINE_BLOCKS.has(child.tagName) || child.properties.dataMarkdownMath === "display")
      ) {
        stamped.set(child, span);
      }
      spread(child, span);
    }
  };
  spread(tree, undefined);
  return stamped;
}

/**
 * A later section of a long file counts its headings on from the ones before it, so a repeated
 * heading keeps the anchor it has in the whole file.
 */
function sectionHeadingIds(
  tree: HastRoot,
  precedingHeadings: ReadonlyArray<string>,
): Map<HastElement, string> {
  const seen = new Map<string, number>();
  for (const heading of precedingHeadings) {
    const slug = githubHeadingSlug(heading);
    seen.set(slug, (seen.get(slug) ?? 0) + 1);
  }
  const ids = new Map<HastElement, string>();
  const visit = (node: HastRoot | HastElement) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (HEADING_LEVELS[child.tagName] === undefined) {
        visit(child);
        continue;
      }
      const slug = githubHeadingSlug(hastPlainTextDeep(child));
      const first = `user-content-${slug}`;
      const id = child.properties.id;
      // An id the author wrote stays. The renderer wrote the others from the heading's slug.
      if (
        !slug ||
        typeof id !== "string" ||
        !id.startsWith(first) ||
        !/^(?:-\d+)?$/.test(id.slice(first.length))
      ) {
        continue;
      }
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      ids.set(child, count === 0 ? first : `${first}-${count}`);
    }
  };
  visit(tree);
  return ids;
}

const documentTrees = new WeakMap<
  HastRoot,
  { lineOffset: number; precedingHeadings: ReadonlyArray<string>; tree: HastRoot }
>();

/**
 * A markdown file's tree: each block stamped with the file lines it was written on, so a
 * selection can name the lines it quotes, and a later section's headings numbered after the
 * ones before it. `lineOffset` is how many lines of the file come before `text`. The parsed
 * tree is shared with other renders and stays as it is.
 */
function documentTree(
  tree: HastRoot,
  text: string,
  lineOffset: number,
  precedingHeadings: ReadonlyArray<string>,
): HastRoot {
  const cached = documentTrees.get(tree);
  if (cached?.lineOffset === lineOffset && cached.precedingHeadings === precedingHeadings) {
    return cached.tree;
  }
  const lines = documentSourceLines(tree, text);
  const ids = precedingHeadings.length > 0 ? sectionHeadingIds(tree, precedingHeadings) : null;
  const stamp = (node: HastElement): HastElement => {
    let children: ElementContent[] | undefined;
    for (const [index, child] of node.children.entries()) {
      if (child.type !== "element") continue;
      const next = stamp(child);
      if (next === child) continue;
      children ??= node.children.slice();
      children[index] = next;
    }
    const span = lines.get(node);
    const id = ids?.get(node);
    if (!children && !span && id === undefined) return node;
    return {
      ...node,
      properties: {
        ...node.properties,
        ...(span
          ? { dataSourceStart: span.start + lineOffset, dataSourceEnd: span.end + lineOffset }
          : {}),
        ...(id === undefined ? {} : { id }),
      },
      children: children ?? node.children,
    };
  };
  const stamped: HastRoot = {
    ...tree,
    children: tree.children.map((child) => (child.type === "element" ? stamp(child) : child)),
  };
  documentTrees.set(tree, { lineOffset, precedingHeadings, tree: stamped });
  return stamped;
}

const MarkdownSource = memo(function MarkdownSource({
  text,
  markdown,
  cache,
}: {
  text: string;
  markdown: WordsHastOptions;
  /** The text will not change again; streamed text would only fill the cache with prefixes. */
  cache: boolean;
}) {
  const render = markdownRenderer(markdown);
  const entry = render.parse(text);
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- Caching during render would make React Compiler rebuild the element when `cache` flips.
  useEffect(() => {
    if (cache) render.remember(text, entry);
  }, [render, text, entry, cache]);
  const islandState = use(ChatMarkdownRendererContext);
  return (
    <ChatMarkdownTextContext value={text}>
      {islandState
        ? renderHastWithIslands(
            islandState.asDocument
              ? documentTree(
                  entry.tree,
                  text,
                  islandState.documentLineOffset,
                  islandState.documentPrecedingHeadings,
                )
              : entry.tree,
            markdownIslandOptions(islandState),
          )
        : render.element(entry)}
    </ChatMarkdownTextContext>
  );
});

function ChatMarkdown({
  text,
  className,
  inline = false,
  lineBreaks = false,
  parseRawHtml = true,
  extensions = NO_EXTENSIONS,
  documentSection,
  onTaskListChange,
  renderInsights = false,
  ...props
}: ChatMarkdownProps) {
  // Task markers are found in this section's text; the caller edits the whole file.
  const sectionOffset = documentSection?.offset ?? 0;
  const onSectionTaskListChange =
    onTaskListChange && sectionOffset > 0
      ? (input: { markerOffset: number; checked: boolean }) =>
          onTaskListChange({ ...input, markerOffset: input.markerOffset + sectionOffset })
      : onTaskListChange;
  // Streaming re-renders only the last block; offsets for task edits, extensions that read the
  // whole message, and a document's source lines need the whole text.
  const streamingBlocks =
    props.isStreaming === true &&
    !inline &&
    extensions === NO_EXTENSIONS &&
    !onTaskListChange &&
    !props.asDocument
      ? (splitMarkdownBlocks(text) ?? [text])
      : null;
  const { componentState, handleCopy, markdownRef, localMediaPreview, closeLocalMediaPreview } =
    useChatMarkdownState(
      { text, inline, ...props, documentSection, onTaskListChange: onSectionTaskListChange },
      streamingBlocks,
    );
  const Root = inline ? "span" : "div";
  const bindMarkdownRef = (node: HTMLElement | null) => {
    markdownRef.current = node;
  };
  const markdown = wordsOptions(extensions, {
    math: componentState.mathEnabled,
    breaks: lineBreaks,
    escapeHtml: !parseRawHtml,
    insights: renderInsights && text.includes("★ Insight"),
  });
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
        <SharedTooltipProvider>
          {blocks.map((source, index) => (
            <MarkdownSource
              // oxlint-disable-next-line react/no-array-index-key -- streamed blocks only change at the end
              key={index}
              text={source}
              markdown={markdown}
              // Every block before the last is finished, so its parse can be reused.
              cache={!props.isStreaming || index < blocks.length - 1}
            />
          ))}
        </SharedTooltipProvider>
      </ChatMarkdownRendererContext>
      {localMediaPreview ? (
        <ExpandedImageDialog preview={localMediaPreview} onClose={closeLocalMediaPreview} />
      ) : null}
    </Root>
  );
}

export default memo(ChatMarkdown);
