import { EnvironmentId, SOURCE_CONTROL_MEDIA_ASSET, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { assetImageCacheKey, assetImageSource } from "./assetImageSource";

const environmentId = EnvironmentId.make("environment-1");

describe("assetImageSource", () => {
  it("caches an attachment under one key across re-signed URLs", () => {
    const resource = { _tag: "attachment", attachmentId: "thread-1-photo.jpg" } as const;
    const first = assetImageSource(
      environmentId,
      resource,
      "https://host/api/assets/token-a/p.jpg",
    );
    const second = assetImageSource(
      environmentId,
      resource,
      "https://host/api/assets/token-b/p.jpg",
    );

    expect(first.cacheKey).toBeDefined();
    expect(second).toStrictEqual({
      uri: "https://host/api/assets/token-b/p.jpg",
      cacheKey: first.cacheKey,
    });
    expect(
      assetImageSource(EnvironmentId.make("environment-2"), resource, "https://other/p.jpg")
        .cacheKey,
    ).not.toBe(first.cacheKey);
  });

  it("keeps ids that contain colons from sharing a key", () => {
    const uri = "https://host/api/assets/token/p.jpg";
    const left = assetImageSource(
      EnvironmentId.make("a"),
      { _tag: "attachment", attachmentId: "b:c" },
      uri,
    );
    const right = assetImageSource(
      EnvironmentId.make("a:b"),
      { _tag: "attachment", attachmentId: "c" },
      uri,
    );

    expect(left.cacheKey).not.toBe(right.cacheKey);
  });

  it("keys host files by the revision the server read, and by URL without one", () => {
    const resource = {
      _tag: "media-file",
      threadId: ThreadId.make("thread-1"),
      path: "docs/shot.png",
    } as const;
    const first = assetImageSource(
      environmentId,
      resource,
      "https://host/api/assets/token-a/shot.png",
      "1:2:5:1000:1000",
    );

    expect(first.cacheKey).toBeDefined();
    expect(
      assetImageSource(
        environmentId,
        resource,
        "https://host/api/assets/token-b/shot.png",
        "1:2:5:1000:1000",
      ),
    ).toStrictEqual({ uri: "https://host/api/assets/token-b/shot.png", cacheKey: first.cacheKey });
    expect(assetImageCacheKey(environmentId, resource, "1:2:5:2000:2000")).not.toBe(first.cacheKey);
    expect(
      assetImageCacheKey(environmentId, { ...resource, path: "docs/other.png" }, "1:2:5:1000:1000"),
    ).not.toBe(first.cacheKey);
    expect(
      assetImageCacheKey(EnvironmentId.make("environment-2"), resource, "1:2:5:1000:1000"),
    ).not.toBe(first.cacheKey);
    expect(
      assetImageSource(
        environmentId,
        { _tag: "draft-workspace-file", cwd: "/repo", path: "logo.png" },
        "https://host/api/assets/token-a/logo.png",
      ),
    ).toStrictEqual({ uri: "https://host/api/assets/token-a/logo.png" });
  });

  it("keys source control media by URL only when its bytes cannot change", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const key = (url: string, environment = environmentId) =>
      assetImageCacheKey(environment, { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url });
    const pinned = key(`https://raw.githubusercontent.com/owner/repo/${sha}/docs/shot.png`);

    expect(pinned).toBeDefined();
    expect(key(`https://github.com/owner/repo/blob/${sha}/docs/shot.png`)).toBe(pinned);
    expect(key(`https://raw.githubusercontent.com/owner/repo/${sha}/docs/other.png`)).not.toBe(
      pinned,
    );
    expect(
      key(
        `https://raw.githubusercontent.com/owner/repo/${sha}/docs/shot.png`,
        EnvironmentId.make("environment-2"),
      ),
    ).not.toBe(pinned);
    expect(key("https://raw.githubusercontent.com/owner/repo/main/docs/shot.png")).toBeUndefined();
  });
});
