import {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";
import { markdownTaskMarkerOffset } from "@t3tools/shared/markdownTaskList";
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
import { createContext, useContext, useMemo, useState } from "react";
import {
  changeRequestLinkResolver,
  changeRequestReferenceAutolinker,
  resolveChangeRequestMediaUrl,
} from "@t3tools/client-runtime/pull-request-markdown";
import {
  sourceControlClients,
  type ReferenceAutolink,
} from "@t3tools/client-runtime/source-control-clients";
import { assetUrlStateFromResult } from "@t3tools/client-runtime/state/assets";
import { linkReferenceAutolinks } from "./pullRequestAutolinks";
import { assetEnvironment } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { markdownImageSources } from "../../lib/markdownImageSources";
import { FilePreviewGallery, useFilePreviewGallery } from "../../components/ui/FilePreviewGallery";
import { pullRequestImageSource, pullRequestMediaSource } from "./pullRequestMediaSource";
import {
  FilePreviewModal,
  type FilePreviewSource,
  type FilePreviewItem,
} from "../../components/ui/FilePreviewModal";
import { ThreadMarkdownImageView } from "../threads/ThreadMarkdownImage";
import type {
  MarkdownImageRenderer,
  MarkdownImageSourceResolver,
} from "../../native/SelectableMarkdownText";
import type { SelectableMarkdownTextProps } from "../../native/SelectableMarkdownText.types";

const AutolinksContext = createContext<((text: string) => ReadonlyArray<ReferenceAutolink>) | null>(
  null,
);
const LineBreaksContext = createContext(false);
const ChangeRequestUrlContext = createContext<string | null>(null);
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
  const lineBreaks = sourceControlClients.find(provider ?? "")?.hardLineBreaks ?? false;
  const linkResolver = changeRequestLinkResolver(props.changeRequest);
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
      <LineBreaksContext value={lineBreaks}>
        <ChangeRequestUrlContext value={url ?? null}>
          <LinkResolverContext value={linkResolver}>
            <PullRequestMediaContext value={media}>{props.children}</PullRequestMediaContext>
          </LinkResolverContext>
        </ChangeRequestUrlContext>
      </LineBreaksContext>
    </AutolinksContext>
  );
}

/** A body's destinations, as its host resolves them; a guide's stay relative to the checkout. */
function useResolveLink() {
  const linkResolver = useContext(LinkResolverContext);
  return (href: string) => linkResolver?.(href) ?? href;
}

function useResolveMediaUrl() {
  const resolveLink = useResolveLink();
  const changeRequestUrl = useContext(ChangeRequestUrlContext);
  return (href: string) => {
    const url = resolveLink(href);
    return changeRequestUrl ? resolveChangeRequestMediaUrl(url, changeRequestUrl) : url;
  };
}

/**
 * Enriched draws an image in a table, list or link itself, from this source, not `renderImage`.
 * It keeps a resolved source for the life of the view, so the view is keyed to everything an
 * answer depends on: the change request it resolves against, the media location and the origin.
 */
function usePullRequestImageSource(resolve: (url: string) => string): {
  readonly resolveImageSource: MarkdownImageSourceResolver;
  readonly sourceKey: string;
} {
  const location = useContext(PullRequestMediaContext);
  const connection = usePreparedConnection(location?.environmentId ?? null);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const resolveImageSource: MarkdownImageSourceResolver = async (image) => {
    const url = resolve(image.href);
    const source = pullRequestMediaSource(url, location);
    if ("uri" in source) return /^https?:\/\//i.test(url) ? { uri: url } : null;
    const state = assetUrlStateFromResult(
      await createUrl({
        environmentId: source.environmentId,
        input: { resource: source.resource },
      }),
      httpBaseUrl,
    );
    if (state._tag !== "Success") throw new Error("Pull request image is unavailable");
    return { uri: state.url };
  };
  return {
    resolveImageSource,
    sourceKey: `${location?.environmentId ?? ""}\n${location?.cwd ?? ""}\n${httpBaseUrl ?? ""}`,
  };
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
      cacheKey={media.cacheKey}
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
  const mediaContext = useContext(PullRequestMediaContext);
  const resolveMediaUrl = useResolveMediaUrl();
  const segments = useMemo(() => splitPullRequestBody(props.markdown), [props.markdown]);
  const [undoneTicks, setUndoneTicks] = useState(0);
  const gallery: FilePreviewItem[] = markdownImageSources(
    props.imageGroupMarkdown ?? props.markdown,
  )
    .map(resolveMediaUrl)
    .filter(
      (uri) =>
        /^https?:\/\//i.test(uri) &&
        videoMimeType({ name: uri.split(/[?#]/)[0] ?? uri, mimeType: "" }) === null,
    )
    .map((uri) => pullRequestImageSource(uri, mediaContext));
  const segmentProps = {
    gallery,
    lineBreaks: props.lineBreaks,
    undoneTicks,
    onTaskListChange: props.onTaskListChange,
    onTaskListUndone: () => setUndoneTicks((count) => count + 1),
  };
  return (
    <View style={{ gap: 12 }}>
      {segments.map((segment) => (
        <PullRequestBodySegmentView key={segment.id} segment={segment} {...segmentProps} />
      ))}
    </View>
  );
}

/** The agent writes the guide about the checkout, so its relative links name workspace files. */
export function PullRequestGuideMarkdown(props: { readonly markdown: string }) {
  return (
    <LinkResolverContext value={null}>
      <PullRequestMarkdown lineBreaks={false} markdown={props.markdown} />
    </LinkResolverContext>
  );
}

function PullRequestBodySegmentView(props: {
  readonly segment: PullRequestBodySegment;
  readonly gallery: FilePreviewItem[];
  readonly lineBreaks: boolean | undefined;
  readonly undoneTicks: number;
  readonly onTaskListChange:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => boolean)
    | undefined;
  readonly onTaskListUndone: () => void;
}) {
  const { segment, onTaskListChange } = props;
  if (segment.kind === "markdown") {
    return (
      <PullRequestMarkdownContent
        key={props.undoneTicks}
        markdown={segment.text}
        gallery={props.gallery}
        lineBreaks={props.lineBreaks}
        onTaskListItemPress={
          onTaskListChange
            ? (event) => {
                const offset = markdownTaskMarkerOffset(
                  segment.text,
                  event.index,
                  event.text,
                  event.checked,
                );
                const kept =
                  offset !== null &&
                  onTaskListChange({
                    markerOffset: segment.sourceOffset + offset,
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
  readonly gallery: FilePreviewItem[];
  readonly lineBreaks: boolean | undefined;
  readonly onTaskListItemPress?: SelectableMarkdownTextProps["onTaskListItemPress"];
}) {
  const hostLineBreaks = useContext(LineBreaksContext);
  const autolinks = useContext(AutolinksContext);
  const mediaContext = useContext(PullRequestMediaContext);
  const changeRequestUrl = useContext(ChangeRequestUrlContext);
  const resolveLink = useResolveLink();
  const resolveMediaUrl = useResolveMediaUrl();
  const markdown = linkReferenceAutolinks(props.markdown, autolinks);
  const openPullRequest = useOpenPullRequest();
  const openLink = (href: string) => {
    void openPullRequest(resolveLink(href));
  };
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const renderImage: MarkdownImageRenderer = (image) => (
    <MarkdownImage href={resolveMediaUrl(image.href)} alt={image.alt} onPreview={setPreview} />
  );
  const { resolveImageSource, sourceKey } = usePullRequestImageSource(resolveMediaUrl);
  const nativeKey = `${changeRequestUrl ?? ""}\n${sourceKey}`;
  const styles = useMarkdownPreviewStyles();
  return (
    <FilePreviewGallery value={props.gallery}>
      <SelectableMarkdownText
        key={nativeKey}
        markdown={markdown}
        preserveSoftBreaks={props.lineBreaks ?? hostLineBreaks}
        textStyle={styles.nativeTextStyle}
        onLinkPress={openLink}
        renderImage={renderImage}
        resolveImageSource={resolveImageSource}
        onImagePress={(href) =>
          setPreview(pullRequestImageSource(resolveMediaUrl(href), mediaContext))
        }
        onTaskListItemPress={props.onTaskListItemPress}
      />
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </FilePreviewGallery>
  );
}
