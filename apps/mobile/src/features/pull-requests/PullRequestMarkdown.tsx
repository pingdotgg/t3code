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
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  changeRequestLinkResolver,
  changeRequestReferenceAutolinker,
} from "@t3tools/client-runtime/pull-request-markdown";
import {
  sourceControlClients,
  type ReferenceAutolink,
} from "@t3tools/client-runtime/source-control-clients";
import { SOURCE_CONTROL_MEDIA_ASSET } from "@t3tools/contracts";
import { assetUrlStateFromResult } from "@t3tools/client-runtime/state/assets";
import { assetEnvironment } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { linkReferenceAutolinks } from "./pullRequestAutolinks";

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
import type {
  MarkdownImageRenderer,
  MarkdownImageSourceResolver,
} from "../../native/SelectableMarkdownText";

const AutolinksContext = createContext<((text: string) => ReadonlyArray<ReferenceAutolink>) | null>(
  null,
);
const LinkResolverContext = createContext<((url: string) => string) | null>(null);

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
  const resolveUrl = changeRequestLinkResolver(props.changeRequest);
  const target = pullRequestTarget(props.params);
  const project = useProject({
    environmentId: target.environmentId,
    projectId: target.input.projectId,
  });
  const cwd = project?.workspaceRoot;
  const media = cwd ? { environmentId: target.environmentId, cwd } : null;
  return (
    <AutolinksContext value={autolinks}>
      <LinkResolverContext value={resolveUrl}>
        <PullRequestMediaContext value={media}>{props.children}</PullRequestMediaContext>
      </LinkResolverContext>
    </AutolinksContext>
  );
}

/** Images Enriched draws natively, such as one inside a list item, load like the standalone ones. */
function usePullRequestImageSource(resolve: (url: string) => string): MarkdownImageSourceResolver {
  const context = useContext(PullRequestMediaContext);
  const connection = usePreparedConnection(context?.environmentId ?? null);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  return useCallback(
    async (image) => {
      const url = resolve(image.href);
      const fetchUrl = sourceControlClients.mediaUrl(url)?.fetchUrl;
      if (!context || !fetchUrl) return /^https?:\/\//i.test(url) ? { uri: url } : null;
      const resource = { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: context.cwd, url: fetchUrl };
      const state = assetUrlStateFromResult(
        await createUrl({ environmentId: context.environmentId, input: { resource } }),
        httpBaseUrl,
      );
      if (state._tag !== "Success") throw new Error("Pull request image is unavailable");
      return { uri: state.url };
    },
    [context, createUrl, httpBaseUrl, resolve],
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
  const segments = useMemo(() => splitPullRequestBody(props.markdown), [props.markdown]);
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
  const autolinks = useContext(AutolinksContext);
  const resolveUrl = useContext(LinkResolverContext);
  const mediaContext = useContext(PullRequestMediaContext);
  const markdown = linkReferenceAutolinks(props.markdown, autolinks);
  const openPullRequest = useOpenPullRequest();
  const resolve = (href: string) => resolveUrl?.(href) ?? href;
  const openLink = (href: string) => {
    void openPullRequest(resolve(href));
  };
  const gallery: FilePreviewItem[] = markdownImageSources(
    props.imageGroupMarkdown ?? props.markdown,
  )
    .map(resolve)
    .filter(
      (uri) =>
        /^https?:\/\//i.test(uri) &&
        videoMimeType({ name: uri.split(/[?#]/)[0] ?? uri, mimeType: "" }) === null,
    )
    .map((uri) => pullRequestImageSource(uri, mediaContext));
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const renderImage: MarkdownImageRenderer = (image) => (
    <MarkdownImage href={resolve(image.href)} alt={image.alt} onPreview={setPreview} />
  );
  const resolveImageSource = usePullRequestImageSource(resolve);
  const styles = useMarkdownPreviewStyles();
  return (
    <FilePreviewGallery value={gallery}>
      <SelectableMarkdownText
        markdown={markdown}
        textStyle={styles.nativeTextStyle}
        onLinkPress={openLink}
        renderImage={renderImage}
        resolveImageSource={resolveImageSource}
        onImagePress={(href) => setPreview(pullRequestImageSource(resolve(href), mediaContext))}
      />
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </FilePreviewGallery>
  );
}
