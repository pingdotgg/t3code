import {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";
import { markdownTaskMarkerOffset } from "@t3tools/shared/markdownTaskList";
import { useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useProject } from "../../state/entities";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import {
  PullRequestGalleryScopeContext,
  PullRequestMedia,
  PullRequestMediaContext,
  usePullRequestMediaUrl,
} from "./PullRequestMedia";
import { createContext, useContext, useId, useMemo, useState } from "react";
import {
  changeRequestReferenceAutolinker,
  resolveChangeRequestMediaUrl,
} from "@t3tools/client-runtime/pull-request-references";
import {
  sourceControlClients,
  type ReferenceAutolink,
} from "@t3tools/client-runtime/source-control-clients";
import { nativePullRequestMarkdown } from "./pullRequestAutolinks";

import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { markdownReferenceDefinitions } from "../../lib/markdownDocument";
import { FilePreviewGallery, useFilePreviewGallery } from "../../components/ui/FilePreviewGallery";
import {
  filePreviewKey,
  filePreviewSourceIdentifier,
  imagePreviewName,
} from "../../lib/filePreviewGallery";
import {
  isPullRequestVideoUrl,
  isPullRequestWebUrl,
  pullRequestImageSource,
  pullRequestMarkdownImages,
  pullRequestMediaSource,
  pullRequestScopedSourceIdentifier,
  pullRequestVideoMimeType,
} from "./pullRequestMediaSource";
import {
  FilePreviewModal,
  type FilePreviewSource,
  type FilePreviewItem,
} from "../../components/ui/FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/ui/VideoPreviewModal";
import { ThreadMarkdownImageView } from "../threads/ThreadMarkdownImage";
import type { MarkdownImageRenderer } from "../../native/SelectableMarkdownText";
import type { SelectableMarkdownTextProps } from "../../native/SelectableMarkdownText.types";

const AutolinksContext = createContext<((text: string) => ReadonlyArray<ReferenceAutolink>) | null>(
  null,
);
const LineBreaksContext = createContext(false);
const GithubEmojiContext = createContext(false);
const ChangeRequestUrlContext = createContext<string | null>(null);

export function PullRequestMarkdownRepository(props: {
  /** The change request the markdown belongs to, whose host decides what its text links. */
  readonly changeRequest: { readonly provider: string; readonly url: string } | null | undefined;
  readonly params: PullRequestParams;
  readonly children: ReactNode;
}) {
  const provider = props.changeRequest?.provider;
  const url = props.changeRequest?.url;
  const autolinks =
    provider === undefined || url === undefined
      ? null
      : changeRequestReferenceAutolinker({ provider, url });
  const lineBreaks = sourceControlClients.find(provider ?? "")?.hardLineBreaks ?? false;
  const target = pullRequestTarget(props.params);
  const project = useProject({
    environmentId: target.environmentId,
    projectId: target.input.projectId,
  });
  const cwd = project?.workspaceRoot;
  const media = cwd
    ? { environmentId: target.environmentId, cwd, repository: target.input.repository }
    : null;
  return (
    <AutolinksContext value={autolinks}>
      <GithubEmojiContext value={provider === "github"}>
        <LineBreaksContext value={lineBreaks}>
          <ChangeRequestUrlContext value={url ?? null}>
            <PullRequestMediaContext value={media}>{props.children}</PullRequestMediaContext>
          </ChangeRequestUrlContext>
        </LineBreaksContext>
      </GithubEmojiContext>
    </AutolinksContext>
  );
}

function MarkdownImage(props: {
  readonly href: string;
  readonly alt: string | null;
  readonly title: string | null;
  readonly onPreview: (source: FilePreviewSource) => void;
}) {
  const gt = useGT();
  const media = usePullRequestMediaUrl(props.href);
  const context = useContext(PullRequestMediaContext);
  const galleryScope = useContext(PullRequestGalleryScopeContext);
  const withGallery = useFilePreviewGallery();
  const label = props.alt?.trim() || props.title?.trim() || null;
  const name = imagePreviewName(props.href, label, gt("Image"));
  const previewSource = pullRequestImageSource(props.href, context, name);
  const sourceIdentifier = galleryScope
    ? pullRequestScopedSourceIdentifier(galleryScope, previewSource)
    : filePreviewSourceIdentifier(previewSource);
  return (
    <ThreadMarkdownImageView
      uri={media.uri}
      sourceKey={props.href}
      sourceIdentifier={sourceIdentifier}
      cacheKey={media.cacheKey}
      unavailable={media.unavailable || !isPullRequestWebUrl(props.href)}
      alt={props.alt}
      actionsSource={previewSource.actionsSource}
      onPressPreview={(source) =>
        props.onPreview(
          withGallery({
            ...previewSource,
            sourceIdentifier: source.sourceIdentifier,
          }),
        )
      }
    />
  );
}

export function PullRequestMarkdown(props: {
  readonly markdown: string;
  readonly imageGroupMarkdown?: string;
  readonly lineBreaks?: boolean;
  /**
   * `markerOffset` is into `markdown`. Returning false, or a tap that can't be traced back to
   * the source, undoes the tick the renderer already drew.
   */
  readonly onTaskListChange?: (input: {
    readonly markerOffset: number;
    readonly checked: boolean;
  }) => boolean;
}) {
  const gt = useGT();
  const imageFallback = gt("Image");
  const galleryScope = `pr-markdown:${useId()}`;
  const mediaContext = useContext(PullRequestMediaContext);
  const changeRequestUrl = useContext(ChangeRequestUrlContext);
  const segments = useMemo(
    () => splitPullRequestBody(props.markdown, markdownReferenceDefinitions),
    [props.markdown],
  );
  const groupSegments = useMemo(
    () =>
      props.imageGroupMarkdown === undefined || props.imageGroupMarkdown === props.markdown
        ? segments
        : splitPullRequestBody(props.imageGroupMarkdown, markdownReferenceDefinitions),
    [props.imageGroupMarkdown, props.markdown, segments],
  );
  const [undoneTicks, setUndoneTicks] = useState(0);
  const gallery = useMemo<FilePreviewItem[]>(
    () =>
      pullRequestMarkdownImages(groupSegments, (href) =>
        changeRequestUrl ? resolveChangeRequestMediaUrl(href, changeRequestUrl) : href,
      ).map(({ uri, alt }) => {
        const name = imagePreviewName(uri, alt, imageFallback);
        const source = pullRequestImageSource(uri, mediaContext, name);
        return {
          ...source,
          sourceIdentifier: pullRequestScopedSourceIdentifier(galleryScope, source),
        };
      }),
    [groupSegments, changeRequestUrl, mediaContext, imageFallback, galleryScope],
  );
  const segmentProps = {
    lineBreaks: props.lineBreaks,
    undoneTicks,
    onTaskListChange: props.onTaskListChange,
    onTaskListUndone: () => setUndoneTicks((count) => count + 1),
  };
  return (
    <PullRequestGalleryScopeContext value={galleryScope}>
      <FilePreviewGallery value={gallery}>
        <View style={{ gap: 12 }}>
          {segments.map((segment) => (
            <PullRequestBodySegmentView key={segment.id} segment={segment} {...segmentProps} />
          ))}
        </View>
      </FilePreviewGallery>
    </PullRequestGalleryScopeContext>
  );
}

function PullRequestBodySegmentView(props: {
  readonly segment: PullRequestBodySegment;
  readonly lineBreaks: boolean | undefined;
  readonly undoneTicks: number;
  readonly onTaskListChange:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => boolean)
    | undefined;
  readonly onTaskListUndone: () => void;
}) {
  const { segment, onTaskListChange } = props;
  const autolinks = useContext(AutolinksContext);
  const githubEmoji = useContext(GithubEmojiContext);
  if (segment.kind === "markdown") {
    const prose = nativePullRequestMarkdown(segment.text, autolinks, githubEmoji);
    return (
      <PullRequestMarkdownContent
        key={props.undoneTicks}
        markdown={prose.markdown}
        lineBreaks={props.lineBreaks}
        onTaskListItemPress={
          onTaskListChange
            ? (event) => {
                const offset = markdownTaskMarkerOffset(
                  prose.markdown,
                  event.index,
                  event.text,
                  event.checked,
                );
                const kept =
                  offset !== null &&
                  onTaskListChange({
                    markerOffset: segment.sourceOffset + prose.sourceOffset(offset),
                    checked: event.checked,
                  });
                if (!kept) props.onTaskListUndone();
              }
            : undefined
        }
      />
    );
  }
  if (segment.kind === "attachment") {
    return <PullRequestMedia url={segment.url} kind={segment.media} />;
  }
  return (
    <View style={{ gap: 12 }}>
      {segment.rows.map((cells, rowIndex) => (
        // oxlint-disable-next-line react/no-array-index-key -- rows have no identity besides position
        <View key={rowIndex} style={{ flexDirection: "row", gap: 12 }}>
          {cells.map((cell, cellIndex) => (
            // oxlint-disable-next-line react/no-array-index-key -- cells have no identity besides position
            <View key={cellIndex} style={{ flex: 1, minWidth: 0, gap: 12 }}>
              {cell.segments.map((cellSegment) => (
                <PullRequestBodySegmentView key={cellSegment.id} {...props} segment={cellSegment} />
              ))}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function PullRequestMarkdownContent(props: {
  readonly markdown: string;
  readonly lineBreaks: boolean | undefined;
  readonly onTaskListItemPress?: SelectableMarkdownTextProps["onTaskListItemPress"];
}) {
  const gt = useGT();
  const gallery = useContext(FilePreviewGallery);
  const hostLineBreaks = useContext(LineBreaksContext);
  const mediaContext = useContext(PullRequestMediaContext);
  const changeRequestUrl = useContext(ChangeRequestUrlContext);
  const resolveMediaUrl = (href: string) =>
    changeRequestUrl ? resolveChangeRequestMediaUrl(href, changeRequestUrl) : href;
  const openPullRequest = useOpenPullRequest();
  const openLink = (href: string) => {
    void openPullRequest(href);
  };
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const [video, setVideo] = useState<VideoPreviewSource | null>(null);
  const renderImage: MarkdownImageRenderer = (image) => {
    const resolvedHref = resolveMediaUrl(image.href);
    if (isPullRequestWebUrl(resolvedHref) && isPullRequestVideoUrl(resolvedHref)) {
      return (
        <PullRequestMedia
          url={resolvedHref}
          kind="video"
          caption={image.alt?.trim() || image.title?.trim() || undefined}
        />
      );
    }
    return (
      <MarkdownImage
        href={resolvedHref}
        alt={image.alt}
        title={image.title}
        onPreview={setPreview}
      />
    );
  };
  const styles = useMarkdownPreviewStyles();
  return (
    <>
      <SelectableMarkdownText
        markdown={props.markdown}
        preserveSoftBreaks={props.lineBreaks ?? hostLineBreaks}
        textStyle={styles.nativeTextStyle}
        onLinkPress={openLink}
        renderImage={renderImage}
        onImagePress={(href) => {
          const uri = resolveMediaUrl(href);
          if (!isPullRequestWebUrl(uri)) return;
          if (isPullRequestVideoUrl(uri)) {
            setVideo({
              type: "media",
              ...pullRequestMediaSource(uri, mediaContext),
              name: uri.split(/[?#]/)[0]?.split("/").pop() || gt("Video"),
              mimeType: pullRequestVideoMimeType(uri) ?? "video/mp4",
            });
            return;
          }
          const source = pullRequestImageSource(
            uri,
            mediaContext,
            imagePreviewName(uri, null, gt("Image")),
          );
          const key = filePreviewKey(source);
          const match = gallery.find((item) => filePreviewKey(item) === key);
          setPreview({ ...(match ?? source), sourceIdentifier: "" });
        }}
        onTaskListItemPress={props.onTaskListItemPress}
      />
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
      <VideoPreviewModal source={video} onRequestClose={() => setVideo(null)} />
    </>
  );
}
