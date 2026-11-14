import { CodexArtifactTemplateCard } from "./chatMarkdownComponentHelpers";
import {
  ChatMarkdownRendererContext,
  ChatMarkdownTextContext,
  findTaskListMarkerOffset,
  markdownHeadingRenderer,
  GITHUB_ALERT_PRESENTATIONS,
  normalizeMarkdownLinkHrefKey,
  orderedListGutterStyle,
} from "./chatMarkdownComponentHelpers";
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
import { InlineAudioPreview } from "../files/InlineAudioPreview";
import { HostImageUrlContext } from "./hostImageUrl";
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
import { createIncrementalMarkdownPlugin } from "../../markdown-incremental";
import type { Pluggable, PluggableList } from "unified";
import { defaultUrlTransform } from "react-markdown";
import { parseAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { AssistantCitationChip } from "./AssistantCitationChip";
import { MarkdownThreadLink } from "./MarkdownThreadLink";
import { mathKind } from "@t3tools/shared/markdownMath";
import remarkMath from "remark-math";
import {
  artifactTemplateFromHastProperties,
  renderCodexInlineDirectivesAsMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { renderSkillInlineMarkdownChildren } from "./SkillInlineText";
import { MarkdownMath } from "./MarkdownMath";
import {
  resolveMarkdownMediaPreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import { markdownImageGallery } from "./markdownImageGallery";
import { type MediaActionSource } from "../media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "../preview/fileExplorerLabel";
import {
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from "./externalLinkContextMenu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { recordVisitForThread } from "../../browserHistoryStore";
import {
  PreferredEditorEnvironmentRequiredError,
  useOpenInPreferredEditor,
  usePreferredEditor,
} from "../../editorPreferences";
import { openInEditorMenuLabel } from "../../editorLabels";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { useClientSettings } from "../../hooks/useSettings";
import { chatMarkdownClipboardPayload } from "../../markdown-clipboard";
import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../../markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "../../markdownFileHostPath";
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { resolveRemoteOpenState, useRemoteOpenResolution } from "../../remoteOpen";
import { useRightPanelStore } from "../../rightPanelStore";
import { readThreadShell, useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { assetEnvironment } from "../../state/assets";
import {
  readEnvironmentScope,
  readPreparedConnection,
  useEnvironmentScope,
} from "../../state/session";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { projectEnvironment } from "../../state/projects";
import { filesystemEnvironment } from "../../state/filesystem";
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
import { useOpenLink } from "../../browser/useOpenLink";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import {
  isBrowserPreviewFile,
  openFileInPreview,
  openUrlInPreview,
  BrowserPreviewUnavailableError,
  BrowserSettingsReadError,
} from "../../browser/openFileInPreview";
import { resolveLinkTarget } from "../../browser/browserLinkTarget";
import { PullRequestLinkPreview } from "../pullRequest/PullRequestLinkPreview";
import { MarkdownCodeBlock, SuspenseShikiCodeBlock } from "./MarkdownCodeBlock";
import { createMarkdownRenderer } from "./markdownRenderer";
import { splitMarkdownBlocks } from "./markdownStreamBlocks";
import { MarkdownMermaidCodeBlock } from "./MarkdownMermaidCodeBlock";
import { MarkdownTable } from "./MarkdownTable";
import { MarkdownDetails } from "./MarkdownDetails";
import {
  authoredImageSizeStyle,
  ChatMarkdownAssetImage,
  ChatMarkdownImage,
  ChatMarkdownImageFallback,
  ChatMarkdownVideo,
  MarkdownLinkContext,
  markdownImageCopy,
} from "./ChatMarkdownMedia";
import { MarkdownExternalLinkContent } from "./MarkdownExternalLink";
import { MarkdownFileLink } from "./MarkdownFileLink";
import { canUseMarkdownFileShellActions } from "./MarkdownFileLink.logic";
import { rehypeChipPunctuation } from "./markdownChipPunctuation";
import { handleMarkdownFragmentClick, rehypeHeadingIds } from "./markdownFragments";
import { rehypeTextDirection } from "./markdownTextDirection";
import { hastHasText, hastPlainTextDeep, plainHastText } from "./markdownHast.logic";
import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  isClosedCodeFence,
  nodeToPlainText,
} from "./MarkdownCodeBlock.logic";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import { useChatMarkdownState } from "../ChatMarkdownParts";

export const CHAT_MARKDOWN_COMPONENTS_LEADING: NonNullable<ReactMarkdownOptions["components"]> = {
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
      const { skills, threadRef } = use(ChatMarkdownRendererContext);
      return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills, threadRef)}</p>;
    },
    blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
      const alert =
        GITHUB_ALERT_PRESENTATIONS[String((props as Record<string, unknown>)["data-alert"] ?? "")];
      if (!alert) {
        return <blockquote {...props}>{children}</blockquote>;
      }
      return (
        <div
          role="note"
          dir={props.dir}
          className={cn("my-1 border-s-2 ps-3", alert.borderClassName)}
        >
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
      const { skills, threadRef } = use(ChatMarkdownRendererContext);
      // Resolve checkbox markers by offset to avoid rerendering list items on every streamed token.
      const isTaskItem = String(props.className ?? "").includes("task-list-item");
      return (
        <li {...props} data-list-item-offset={isTaskItem ? node?.position?.start.offset : undefined}>
          {renderSkillInlineMarkdownChildren(children, skills, threadRef)}
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
      const threadLink = href ? parseThreadLinkHref(href) : null;
      if (threadLink) {
        const written = hastPlainTextDeep(node);
        // An autolink's text is its own URL, which is no label.
        const label = written && parseThreadLinkHref(written) === null ? written : null;
        return environmentId ? (
          <MarkdownThreadLink environmentId={environmentId} link={threadLink} label={label} />
        ) : (
          <span>{label ?? "Thread"}</span>
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
                // Open desktop Alt-clicks before Chromium downloads them so link routers can read the held key.
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
          <span className="whitespace-normal">{children} </span>
          {chip}
        </span>
      );
    },
};
