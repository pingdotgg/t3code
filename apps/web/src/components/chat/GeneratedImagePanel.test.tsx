import { EnvironmentId, EventId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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

const environmentId = EnvironmentId.make("environment-local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));

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
        environmentId={environmentId}
        threadRef={threadRef}
        activityId={EventId.make("activity-generated-image")}
        name="generated.png"
      />,
    );

    expect(markup).toContain('alt="generated.png"');
    expect(markup).toContain(
      'src="https://environment.example/api/assets/generated-image/generated.png"',
    );
  });
});
