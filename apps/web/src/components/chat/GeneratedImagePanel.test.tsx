import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, EventId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GeneratedImagePanel } from "./GeneratedImagePanel";

const assetUrlState = vi.hoisted(() => ({
  current: {
    _tag: "Success" as const,
    url: "https://environment.example/api/assets/generated-image/generated.png",
  },
}));

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => assetUrlState.current,
}));

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

beforeEach(() => {
  assetUrlState.current = {
    _tag: "Success",
    url: "https://environment.example/api/assets/generated-image/generated.png",
  };
});

describe("GeneratedImagePanel", () => {
  it("renders the selected generated image", () => {
    const markup = renderToStaticMarkup(
      <GeneratedImagePanel
        threadRef={threadRef}
        activityId={EventId.make("activity-generated-image")}
        name="generated.png"
        loadRequestId={1}
      />,
    );

    expect(markup).toContain('alt="generated.png"');
    expect(markup).toContain(
      'src="https://environment.example/api/assets/generated-image/generated.png?t3LoadRequest=1"',
    );
  });

  it("bypasses cached image bytes when the panel is reopened", () => {
    const firstMarkup = renderToStaticMarkup(
      <GeneratedImagePanel
        threadRef={threadRef}
        activityId={EventId.make("activity-generated-image")}
        name="generated.png"
        loadRequestId={1}
      />,
    );
    const reopenedMarkup = renderToStaticMarkup(
      <GeneratedImagePanel
        threadRef={threadRef}
        activityId={EventId.make("activity-generated-image")}
        name="generated.png"
        loadRequestId={2}
      />,
    );

    expect(firstMarkup).toContain("t3LoadRequest=1");
    expect(reopenedMarkup).toContain("t3LoadRequest=2");
  });
});
