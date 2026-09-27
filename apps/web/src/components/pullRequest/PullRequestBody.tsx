import { useMemo } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { splitPullRequestBody } from "./pullRequestMedia";
import type { PullRequestMediaPreview } from "./PullRequestMediaDialog";
import { toRenderablePullRequestMarkdown } from "./pullRequestPresentation";

export function PullRequestBody({
  body,
  cwd,
  onPreview,
}: {
  readonly body: string;
  readonly cwd: string;
  readonly onPreview: (preview: PullRequestMediaPreview) => void;
}) {
  const segments = useMemo(() => splitPullRequestBody(body), [body]);
  const handleImageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !(event.target instanceof HTMLImageElement)) return;
    event.preventDefault();
    event.stopPropagation();
    onPreview({
      type: "image",
      src: event.target.currentSrc || event.target.src,
      name: event.target.alt || "Pull request image",
    });
  };

  if (segments.length === 1 && segments[0]?.kind === "markdown") {
    return (
      <div className="pull-request-body" data-image-gallery onClickCapture={handleImageClick}>
        <ChatMarkdown cwd={cwd} text={toRenderablePullRequestMarkdown(segments[0].text)} />
      </div>
    );
  }

  return (
    <div className="pull-request-body space-y-3" data-image-gallery>
      {segments.map((segment) =>
        segment.kind === "markdown" ? (
          <div key={segment.id} onClickCapture={handleImageClick}>
            <ChatMarkdown cwd={cwd} text={toRenderablePullRequestMarkdown(segment.text)} />
          </div>
        ) : (
          <button
            aria-label="Expand pull request video"
            className="block w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/60 bg-black text-left"
            key={segment.id}
            type="button"
            onClick={() =>
              onPreview({
                type: "video",
                src: segment.url,
                name: "Pull request video",
              })
            }
          >
            <video
              aria-hidden
              className="block max-h-80 w-full object-contain"
              muted
              preload="none"
              src={segment.url}
            />
          </button>
        ),
      )}
    </div>
  );
}
