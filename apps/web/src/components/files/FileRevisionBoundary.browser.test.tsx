import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AssetUrlState } from "~/assets/assetUrls";
import { render } from "../../../test/render";

const { assets } = vi.hoisted(() => ({
  assets: { state: { _tag: "Loading" } as unknown as AssetUrlState },
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: () => assets.state,
}));

import { FileRevisionBoundary } from "./FileRevisionBoundary";

const success = (fileRevision?: string) =>
  ({
    _tag: "Success",
    url: "https://environment.test/report.docx",
    refresh: () => undefined,
    ...(fileRevision === undefined ? {} : { fileRevision }),
  }) as unknown as AssetUrlState;

// regression: every agent command or edit anywhere in the project remounted an open Word file,
// which loaded it again and went back to its start.
describe("FileRevisionBoundary", () => {
  const mounts = vi.fn();
  function Preview() {
    useEffect(() => mounts(), []);
    return <p>Report</p>;
  }
  const boundary = (refreshToken: string) => (
    <FileRevisionBoundary
      environmentId={EnvironmentId.make("environment")}
      resource={{ _tag: "media-file", threadId: ThreadId.make("thread"), path: "/p/report.docx" }}
      refreshToken={refreshToken}
    >
      <Preview />
    </FileRevisionBoundary>
  );

  it("remounts a preview only when its file's revision changes", async () => {
    mounts.mockReset();
    assets.state = { _tag: "Loading" } as unknown as AssetUrlState;
    await using screen = await render(boundary("a"));
    assets.state = success("r1");
    await screen.rerender(boundary("a"));
    // The agent ran a command: the check is under way, then finds the file unchanged.
    assets.state = { _tag: "Loading" } as unknown as AssetUrlState;
    await screen.rerender(boundary("b"));
    assets.state = success("r1");
    await screen.rerender(boundary("b"));
    expect(mounts).toHaveBeenCalledTimes(1);
    // The agent rewrote the file.
    assets.state = success("r2");
    await screen.rerender(boundary("c"));
    expect(mounts).toHaveBeenCalledTimes(2);
  });

  it("retries a preview that opened before its file could be read", async () => {
    mounts.mockReset();
    assets.state = { _tag: "Failure", refresh: () => undefined } as unknown as AssetUrlState;
    await using screen = await render(boundary("a"));
    // The file appeared and the panel was refreshed.
    assets.state = success("r1");
    await screen.rerender(boundary("b"));
    expect(mounts).toHaveBeenCalledTimes(2);
  });

  it("remounts on every possible change when the environment reports no revision", async () => {
    mounts.mockReset();
    assets.state = success();
    await using screen = await render(boundary("a"));
    await screen.rerender(boundary("b"));
    expect(mounts).toHaveBeenCalledTimes(2);
  });
});
