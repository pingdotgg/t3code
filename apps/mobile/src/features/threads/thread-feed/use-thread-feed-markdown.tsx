import { isPdfFile } from "../../../lib/filePreview.ts";
/**
 * Thread feed markdown surface: link/image handlers and reasoning rendering.
 */
import { ThreadMarkdownVideo, ThreadMediaVisibleContext } from "../ThreadMarkdownVideo";
import { useMarkdownImageSource } from "../../../native/useMarkdownImageSource";
import {
  enrichedContextLinkCustomization,
  enrichedThreadLinkCustomization,
  withChipIcon,
} from "../../../native/useEnrichedLinkVariants";
import {
  enrichedSkillDisplayName,
  enrichedSkillInstructionsPath,
  enrichedSkillReference,
} from "../../../lib/enrichedLinkPresentation";
import * as Haptics from "expo-haptics";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthFilesystemReadScope,
  idleCompactionOf,
  type OrchestrationMessageContext,
  ThreadId,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
  type ScheduledTaskId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { hostedThreadLink, parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import {
  executeAtomQuery,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useId,
  type ComponentPropsWithRef,
  type ComponentRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { FilePreviewModal, type FilePreviewSource } from "../../../components/FilePreviewModal";
import { ThreadInlineFilePreview } from "../ThreadInlineFilePreview";
import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import {
  SelectableMarkdownText,
  type MarkdownFileContextMenu,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
  type MarkdownLinkCustomization,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../../native/SelectableMarkdownText";
import { AppText as Text } from "../../../components/ui/AppText";
import { markdownFileEmbedLabel, resolveMarkdownMediaPreview } from "../../../lib/markdownMedia";
import {
  ReviewCommentCard,
  useReviewCommentColors,
  type ReviewCommentColors,
} from "../../review/ReviewCommentCard";
import {
  normalizeNativeMarkdownUrl,
  resolveMarkdownLinkPresentation,
} from "../../../lib/markdownLinks";
import {
  createThreadFeedCache,
  threadFeedCompactionLabels,
  failedFeedRunIds,
  deriveThreadFeedPresentation,
  threadFeedRunIsUnsettled,
  isContextCompactionActivityGroup,
  isContextHandoffActivityGroup,
  isLinkRequestActivityGroup,
  isSecretRequestActivityGroup,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
  messageFoldRunId,
} from "../../../lib/threadActivity";
import { readEnvironmentScope, usePreparedConnection } from "../../../state/session";
import { projectEnvironment } from "../../../state/projects";
import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import {
  resolveThreadLink,
  useLiveThreadLinkLabels,
  useQuietThreadShell,
  useThreadChipIcons,
} from "../../../state/entities";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../../state/threads";
import {
  fileRoutePathSegments,
  resolveFileLinkPath,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from "../../files/filePath";
import { fileChipClipboardPath, fileChipMenu, resolveFileChipTarget } from "../fileChipMenu";
import {
  MarkdownImageAvailableWidthContext,
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "../ThreadMarkdownImage";
import type {
  MarkdownLinkHandlers,
} from "./markdown.tsx";
import {
  AssistantMarkdownContent,
  useMarkdownStyles,
} from "./markdown.tsx";
import type { ThreadFeedProps } from "./types.ts";
import type { ThreadFeedView } from "./use-thread-feed-view.tsx";

export function useThreadFeedMarkdown(
  props: ThreadFeedProps,
  view: ThreadFeedView,
) {
  const {
    openPullRequest,
    navigation,
    openLinkedThread,
    abortMarkdownLinkRequest,
    beginMarkdownLinkRequest,
    onInlinePlaybackStart,
    markdownLinkScope,
    openPreview,
    shareFileChip,
  } = view;
  const openSkillInstructions = (path: string) => {
    void Haptics.selectionAsync();
    navigation.navigate("ThreadFile", {
      environmentId: String(props.environmentId),
      threadId: String(props.threadId),
      path: fileRoutePathSegments(path),
    });
  };
  const resolveLinkedThread = (href: string) => {
    const link = parseThreadLinkHref(href);
    if (!link) return null;
    const resolved = resolveThreadLink(
      (atom) => appAtomRegistry.get(atom),
      link,
      props.environmentId,
    );
    if (resolved !== null || link.environmentId !== null) return resolved;
    // A v1 link names no environment, so it falls back to this message's.
    return scopeThreadRef(props.environmentId, link.threadId);
  };
  const onMarkdownLinkPress = (href: string, imageEmbed = false) => {
    const request = beginMarkdownLinkRequest();
    const skill = enrichedSkillReference(href, props.skills);
    if (skill) {
      const instructionsPath = enrichedSkillInstructionsPath(skill);
      if (instructionsPath) openSkillInstructions(instructionsPath);
      return;
    }
    if (parseThreadLinkHref(href)) {
      const target = resolveLinkedThread(href);
      if (target) {
        openLinkedThread({
          environmentId: String(target.environmentId),
          threadId: String(target.threadId),
        });
      }
      return;
    }
    const media = resolveMarkdownMediaPreview(href, {
      environmentId: props.environmentId,
      threadId: props.threadId,
      workspaceRoot: props.workspaceRoot,
      imageEmbed,
    });
    if (media && media.kind !== "file") {
      void Haptics.selectionAsync();
      const scope = markdownLinkScope;
      const openMediaPreview = () => {
        if (request.signal.aborted) return;
        openPreview(
          scope,
          media.kind === "video" ? { video: media.source } : { file: media.source },
        );
      };
      const resource = "resource" in media.source ? media.source.resource : null;
      const mediaPath = resource && "path" in resource ? resource.path : null;
      if (
        typeof mediaPath === "string" &&
        readEnvironmentScope(props.environmentId, AuthFilesystemReadScope)
      ) {
        void executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.fileMetadata({
            environmentId: props.environmentId,
            input: { path: mediaPath },
          }),
          { signal: request.signal, reportFailure: false, reportDefect: false },
        ).then((result) => {
          if (request.signal.aborted) return;
          if (result._tag === "Success" && result.value?.kind === "directory") {
            navigation.navigate("ThreadFile", {
              environmentId: String(props.environmentId),
              threadId: String(props.threadId),
              path: fileRoutePathSegments(mediaPath),
            });
          } else openMediaPreview();
        }, openMediaPreview);
      } else openMediaPreview();
      return;
    }

    const presentation = resolveMarkdownLinkPresentation(href);
    if (presentation.kind === "file") {
      const path = resolveFileLinkPath(props.workspaceRoot, presentation.path);
      if (path === null) return;
      const relativePath = resolveWorkspaceRelativeFilePath(props.workspaceRoot, path);
      const openAt = (target: string) => {
        if (request.signal.aborted) return;
        void Haptics.selectionAsync();
        navigation.navigate("ThreadFile", {
          environmentId: String(props.environmentId),
          threadId: String(props.threadId),
          path: fileRoutePathSegments(target),
          ...(presentation.line ? { line: String(presentation.line) } : {}),
        });
      };
      if (
        props.workspaceRoot &&
        relativePath &&
        !/[\\/]$/.test(presentation.path) &&
        needsWorkspaceBasenameLookup(relativePath) &&
        readEnvironmentScope(props.environmentId, AuthFilesystemReadScope)
      ) {
        const originalPath = resolveWorkspaceFilePath(props.workspaceRoot, relativePath);
        void executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.searchEntries({
            environmentId: props.environmentId,
            input: {
              cwd: props.workspaceRoot,
              query: relativePath,
              kind: "file",
              limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
            },
          }),
          { signal: request.signal, reportFailure: false, reportDefect: false },
        ).then(
          (result) => {
            const match =
              result._tag === "Success"
                ? pickWorkspaceBasenameMatch(relativePath, result.value.entries)
                : null;
            if (!match || match === relativePath) {
              openAt(relativePath);
              return;
            }
            if (request.signal.aborted) return;
            void executeAtomQuery(
              appAtomRegistry,
              projectEnvironment.fileMetadata({
                environmentId: props.environmentId,
                input: { path: originalPath },
              }),
              { signal: request.signal, reportFailure: false, reportDefect: false },
            ).then(
              (metadata) =>
                openAt(
                  metadata._tag === "Success" && metadata.value?.kind !== "directory"
                    ? match
                    : relativePath,
                ),
              () => openAt(relativePath),
            );
          },
          () => openAt(relativePath),
        );
      } else openAt(relativePath ?? path);
      return;
    }

    if (presentation.href) {
      if (/^https?:\/\//i.test(presentation.href) && isPdfFile({ name: presentation.href })) {
        openPreview(markdownLinkScope, {
          file: { kind: "pdf", uri: presentation.href, name: "Document.pdf" },
        });
        return;
      }
      void openPullRequest(presentation.href);
    }
  };
  const resolveImageSource = useMarkdownImageSource({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: props.workspaceRoot ?? null,
  });
  const markdownLinkHandlers: MarkdownLinkHandlers = {
    fileEmbedLabel: (href, standalone) =>
      markdownFileEmbedLabel(
        href,
        {
          environmentId: props.environmentId,
          threadId: props.threadId,
          workspaceRoot: props.workspaceRoot,
        },
        standalone,
      ),
    onLinkPress: onMarkdownLinkPress,
    linkCustomization: enrichedThreadLinkCustomization,
    onImagePress: (href) => onMarkdownLinkPress(href, true),
    resolveImageSource,
    fileContextMenu: (href) => {
      const skill = enrichedSkillReference(href, props.skills);
      if (skill) {
        return {
          title: enrichedSkillDisplayName(skill),
          actions: [
            {
              id: "open-skill",
              title: "View instructions",
              disabled: !enrichedSkillInstructionsPath(skill),
            },
            { id: "copy-skill", title: "Copy skill" },
          ],
        };
      }
      const thread = resolveLinkedThread(href);
      if (thread) {
        return {
          title:
            appAtomRegistry.get(environmentThreadShells.threadShellAtom(thread))?.title ?? "Thread",
          actions: [
            { id: "open-thread", title: "Open thread" },
            { id: "copy-thread-link", title: "Copy link" },
          ],
        };
      }
      const target = resolveFileChipTarget(href, props.workspaceRoot);
      return target ? fileChipMenu(target) : undefined;
    },
    onFileContextMenuAction: (href, actionId) => {
      const skill = enrichedSkillReference(href, props.skills);
      if (skill) {
        const instructionsPath = enrichedSkillInstructionsPath(skill);
        if (actionId === "open-skill" && instructionsPath) openSkillInstructions(instructionsPath);
        else if (actionId === "copy-skill") copyTextWithHaptic(`$${skill.name}`);
        return;
      }
      const thread = resolveLinkedThread(href);
      if (thread) {
        if (actionId === "open-thread") onMarkdownLinkPress(href);
        else if (actionId === "copy-thread-link") copyTextWithHaptic(hostedThreadLink(thread));
        return;
      }
      const target = resolveFileChipTarget(href, props.workspaceRoot);
      if (!target) return;
      switch (actionId) {
        case "copy-full-path":
        case "copy-relative-path": {
          const clipboardPath = fileChipClipboardPath(target, actionId);
          if (clipboardPath !== undefined) copyTextWithHaptic(clipboardPath);
          return;
        }
        case "open-file":
          onMarkdownLinkPress(href);
          return;
        case "save":
          shareFileChip(target);
          return;
      }
    },
  };
  const renderMarkdownImage: MarkdownImageRenderer = (image) => {
    const media = resolveMarkdownMediaPreview(image.href, {
      environmentId: props.environmentId,
      threadId: props.threadId,
      workspaceRoot: props.workspaceRoot,
      imageEmbed: true,
    });
    if (media?.kind === "video") {
      return (
        <ThreadMarkdownVideo
          key={image.href}
          source={{ ...media.source, name: image.alt ?? media.source.name }}
          onPlaybackStart={onInlinePlaybackStart}
        />
      );
    }
    if (media?.kind === "audio") {
      return (
        <ThreadInlineFilePreview
          key={image.href}
          source={media.source}
          onOpen={() => onMarkdownLinkPress(image.href, true)}
          onPlaybackStart={onInlinePlaybackStart}
        />
      );
    }
    const fileLink = resolveMarkdownLinkPresentation(image.href);
    if (
      (media && (media.kind === "pdf" || media.kind === "document" || media.kind === "file")) ||
      (fileLink.kind === "file" && fileLink.line !== undefined)
    ) {
      const name = media?.source.name ?? (fileLink.kind === "file" ? fileLink.label : "Open file");
      return (
        <Text
          accessibilityRole="link"
          accessibilityLabel={`Open ${name}`}
          onPress={() => onMarkdownLinkPress(image.href, true)}
          style={{
            color: markdownStyles.assistant.nativeTextStyle.linkColor,
            fontSize: markdownStyles.assistant.nativeTextStyle.fontSize,
            lineHeight: markdownStyles.assistant.nativeTextStyle.lineHeight,
          }}
        >
          {name}
        </Text>
      );
    }
    const imageSource = classifyMarkdownImageSource(image.href, props.workspaceRoot ?? null);
    if (imageSource._tag === "Direct") {
      return (
        <ThreadMarkdownImageView
          uri={normalizeNativeMarkdownUrl(imageSource.uri)}
          sourceKey={imageSource.uri}
          format={
            /\.svg(?:[?#]|$)/i.test(imageSource.uri) ||
            imageSource.uri.startsWith("data:image/svg+xml")
              ? "svg"
              : undefined
          }
          unavailable={false}
          alt={image.alt}
          actionsSource={media?.source.actionsSource}
          onPressPreview={onPressPreview}
        />
      );
    }
    if (imageSource._tag === "Blocked") {
      return <ThreadMarkdownImageUnavailable alt={image.alt} />;
    }
    return (
      <ThreadMarkdownImage
        environmentId={props.environmentId}
        resource={{
          _tag: "media-file",
          threadId: props.threadId,
          path: imageSource.path,
        }}
        alt={image.alt}
        srcFragment={markdownImageSourceFragment(image.href)}
        actionsSource={media?.source.actionsSource}
        onPressPreview={onPressPreview}
      />
    );
  };
  const renderViewedImage: MarkdownImageRenderer = (image) => {
    const viewedImage = resolveViewedImageAsset(image.href, {
      threadId: props.threadId,
      workspaceRoot: props.workspaceRoot,
    });
    const media = viewedImage
      ? resolveMarkdownMediaPreview(image.href, {
          environmentId: props.environmentId,
          threadId: props.threadId,
          workspaceRoot: props.workspaceRoot,
          imageEmbed: true,
        })
      : null;
    const actionsSource = media?.source.actionsSource;
    return viewedImage ? (
      <ThreadMarkdownImage
        environmentId={props.environmentId}
        resource={viewedImage.resource}
        alt={viewedImage.alt}
        srcFragment={viewedImage.srcFragment}
        actionsSource={
          actionsSource && "resource" in actionsSource
            ? { ...actionsSource, resource: viewedImage.resource }
            : undefined
        }
        onPressPreview={onPressPreview}
      />
    ) : null;
  };
  const markdownStyles = useMarkdownStyles();
  const renderReasoning = (text: string) => (
    <AssistantMarkdownContent
      markdown={text}
      environmentId={props.environmentId}
      markdownStyles={markdownStyles.assistant}
      linkHandlers={markdownLinkHandlers}
      renderImage={renderMarkdownImage}
      skills={props.skills}
    />
  );
  const reviewCommentColors = useReviewCommentColors();
  const unsettledTurnId = threadFeedRunIsUnsettled(props.latestRun) ? props.latestRun.runId : null;
  const compactionLabelsByEntryId = useMemo(
    () => threadFeedCompactionLabels(props.feed),
    [props.feed],
  );
  // LegendList does not invalidate visible rows when only the renderItem closure changes.
  // Include turn completion so unchanged message rows reveal their footer and spacing

  const onPressPreview = (source: FilePreviewSource) => {
    abortMarkdownLinkRequest();
    openPreview(markdownLinkScope, { file: source });
  };

  return {
    onPressPreview,
    openSkillInstructions,
    resolveLinkedThread,
    onMarkdownLinkPress,
    resolveImageSource,
    markdownLinkHandlers,
    renderMarkdownImage,
    renderViewedImage,
    markdownStyles,
    renderReasoning,
    reviewCommentColors,
    unsettledTurnId,
    compactionLabelsByEntryId,
  };
}

export type ThreadFeedMarkdown = ReturnType<typeof useThreadFeedMarkdown>;
