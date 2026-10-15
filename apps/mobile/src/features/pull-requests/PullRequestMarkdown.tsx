import { splitPullRequestBody } from "@t3tools/client-runtime/pull-request-markdown";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useProject } from "../../state/entities";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import {
  PullRequestMedia,
  PullRequestMediaContext,
  usePullRequestMediaUrl,
} from "./PullRequestMedia";
import { videoMimeType } from "@t3tools/shared/video";
import { createContext, useContext, useCallback, useMemo, useState } from "react";
import { githubMarkdownLinks } from "@t3tools/shared/githubMarkdownLinks";

import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { markdownImageSources } from "../../lib/markdownImageSources";
import { FilePreviewGallery, useFilePreviewGallery } from "../../components/FilePreviewGallery";
import { pullRequestImageSource } from "./pullRequestMediaSource";
import {
  FilePreviewModal,
  type FilePreviewSource,
  type FilePreviewItem,
} from "../../components/FilePreviewModal";
import { ThreadMarkdownImageView } from "../threads/ThreadMarkdownImage";
import type { MarkdownImageRenderer } from "../../native/SelectableMarkdownText";
import { isBotBadgeImage } from "./botBadgeImages";
import { inlinePullRequestBadges } from "./pullRequestMarkdownBadges";

const RepositoryContext = createContext<string | null>(null);

export function PullRequestMarkdownRepository(props: {
  readonly value: string | null;
  readonly params: PullRequestParams;
  readonly children: ReactNode;
}) {
  const target = pullRequestTarget(props.params);
  const project = useProject({
    environmentId: target.environmentId,
    projectId: target.input.projectId,
  });
  const cwd = project?.workspaceRoot;
  const media = useMemo(
    () => (cwd ? { environmentId: target.environmentId, cwd } : null),
    [target.environmentId, cwd],
  );
  return (
    <RepositoryContext value={props.value}>
      <PullRequestMediaContext value={media}>{props.children}</PullRequestMediaContext>
    </RepositoryContext>
  );
}

function MarkdownImage(props: {
  readonly href: string;
  readonly alt: string | null;
  readonly onPreview: (source: FilePreviewSource) => void;
}) {
  const media = usePullRequestMediaUrl(props.href);
  const context = useContext(PullRequestMediaContext);
  const withGallery = useFilePreviewGallery();
  return (
    <ThreadMarkdownImageView
      uri={media.uri}
      sourceKey={props.href}
      unavailable={media.unavailable || !/^https?:\/\//i.test(props.href)}
      alt={props.alt}
      onPressPreview={(source) =>
        props.onPreview(
          withGallery({
            ...pullRequestImageSource(props.href, context),
            name: source.name,
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
}) {
  const segments = useMemo(
    () => splitPullRequestBody(inlinePullRequestBadges(props.markdown)),
    [props.markdown],
  );
  return (
    <View style={{ gap: 12 }}>
      {segments.map((segment) =>
        segment.kind === "markdown" ? (
          <PullRequestMarkdownContent
            key={segment.id}
            markdown={segment.text}
            imageGroupMarkdown={props.imageGroupMarkdown ?? props.markdown}
          />
        ) : (
          <PullRequestMedia key={segment.id} url={segment.url} kind={segment.media} />
        ),
      )}
    </View>
  );
}

function PullRequestMarkdownContent(props: {
  readonly markdown: string;
  readonly imageGroupMarkdown?: string;
}) {
  const repositoryUrl = useContext(RepositoryContext);
  const mediaContext = useContext(PullRequestMediaContext);
  const markdown = useMemo(
    () => githubMarkdownLinks(props.markdown, repositoryUrl),
    [props.markdown, repositoryUrl],
  );
  const openPullRequest = useOpenPullRequest();
  const openLink = useCallback(
    (href: string) => {
      void openPullRequest(href);
    },
    [openPullRequest],
  );
  const gallery = useMemo<FilePreviewItem[]>(
    () =>
      markdownImageSources(props.imageGroupMarkdown ?? props.markdown)
        .filter(
          (uri) =>
            /^https?:\/\//i.test(uri) &&
            !isBotBadgeImage(uri) &&
            videoMimeType({ name: uri.split(/[?#]/)[0] ?? uri, mimeType: "" }) === null,
        )
        .map((uri) => pullRequestImageSource(uri, mediaContext)),
    [props.markdown, props.imageGroupMarkdown, mediaContext],
  );
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => <MarkdownImage href={image.href} alt={image.alt} onPreview={setPreview} />,
    [],
  );
  const styles = useMarkdownPreviewStyles();
  return (
    <FilePreviewGallery value={gallery}>
      <SelectableMarkdownText
        markdown={markdown}
        textStyle={styles.nativeTextStyle}
        onLinkPress={openLink}
        renderImage={renderImage}
        onImagePress={(href) => setPreview(pullRequestImageSource(href, mediaContext))}
      />
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </FilePreviewGallery>
  );
}
