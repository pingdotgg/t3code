import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { assetImageCacheKey, assetImageSource } from "./assetImageSource";

const environmentId = EnvironmentId.make("environment-1");

describe("assetImageSource", () => {
  it("caches an attachment under one key per file revision across re-signed URLs", () => {
    const resource = { _tag: "attachment", attachmentId: "thread-1-photo.jpg" } as const;
    const first = assetImageSource(environmentId, resource, {
      url: "https://host/api/assets/token-a/p.jpg",
      fileRevision: "rev-1",
    });
    const second = assetImageSource(environmentId, resource, {
      url: "https://host/api/assets/token-b/p.jpg",
      fileRevision: "rev-1",
    });
    const edited = assetImageSource(environmentId, resource, {
      url: "https://host/api/assets/token-c/p.jpg",
      fileRevision: "rev-2",
    });
    const olderServer = assetImageSource(environmentId, resource, {
      url: "https://host/api/assets/token-d/p.jpg",
    });

    expect(first.cacheKey).toBeDefined();
    expect(second).toStrictEqual({
      uri: "https://host/api/assets/token-b/p.jpg",
      cacheKey: first.cacheKey,
    });
    expect(
      assetImageSource(EnvironmentId.make("environment-2"), resource, {
        url: "https://other/p.jpg",
      }).cacheKey,
    ).not.toBe(first.cacheKey);
    expect(edited.cacheKey).not.toBe(first.cacheKey);
    expect(olderServer.cacheKey).toBeDefined();
    expect(olderServer.cacheKey).not.toBe(first.cacheKey);
  });

  it("keeps ids that contain colons from sharing a key", () => {
    const uri = "https://host/api/assets/token/p.jpg";
    const left = assetImageSource(
      EnvironmentId.make("a"),
      { _tag: "attachment", attachmentId: "b:c" },
      { url: uri },
    );
    const right = assetImageSource(
      EnvironmentId.make("a:b"),
      { _tag: "attachment", attachmentId: "c" },
      { url: uri },
    );

    expect(left.cacheKey).not.toBe(right.cacheKey);
  });

  it("keeps workspace files keyed by URL because they can change on disk", () => {
    const source = assetImageSource(
      environmentId,
      { _tag: "draft-workspace-file", cwd: "/repo", path: "logo.png" },
      { url: "https://host/api/assets/token-a/logo.png" },
    );

    expect(source).toStrictEqual({ uri: "https://host/api/assets/token-a/logo.png" });
  });

  it("keeps tool output images keyed by URL because a tool can replace them", () => {
    expect(
      assetImageSource(
        environmentId,
        {
          _tag: "tool-output-image",
          threadId: ThreadId.make("thread-1"),
          itemId: TurnItemId.make("item-1"),
          index: 0,
        },
        { url: "https://host/api/assets/token-a/image-1.png" },
      ),
    ).toStrictEqual({ uri: "https://host/api/assets/token-a/image-1.png" });
  });

  it("keys GitHub uploads and pinned files per environment and credential, sharing blob and raw links", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const key = (url: string, environment = environmentId, version = { accessScope: "a" }) =>
      assetImageCacheKey(environment, { _tag: "github-media", cwd: "/repo", url }, version);
    const upload = key(
      "https://github.com/user-attachments/assets/0f3c2b1a-1111-2222-3333-444455556666",
    );
    const pinned = key(`https://raw.githubusercontent.com/owner/repo/${sha}/docs/shot.png`);

    expect(upload).toBeDefined();
    expect(pinned).toBeDefined();
    expect(key(`https://github.com/owner/repo/blob/${sha}/docs/shot.png`)).toBe(pinned);
    expect(
      key(
        "https://github.com/user-attachments/assets/0f3c2b1a-1111-2222-3333-444455556666",
        EnvironmentId.make("environment-2"),
      ),
    ).not.toBe(upload);
    expect(
      key(`https://raw.githubusercontent.com/owner/repo/${sha}/docs/shot.png`, environmentId, {
        accessScope: "b",
      }),
    ).not.toBe(pinned);
    expect(
      assetImageCacheKey(environmentId, {
        _tag: "github-media",
        cwd: "/repo",
        url: `https://github.com/owner/repo/blob/${sha}/a.png`,
      }),
    ).toBeUndefined();
  });

  it("keeps GitHub files at branches, tags, short SHAs and 64-hex refs keyed by URL", () => {
    const urls = [
      "https://raw.githubusercontent.com/owner/repo/main/docs/shot.png",
      "https://github.com/owner/repo/blob/v1.2.3/docs/shot.png",
      "https://raw.githubusercontent.com/owner/repo/0123456789ab/shot.png",
      `https://raw.githubusercontent.com/owner/repo/${"a".repeat(64)}/shot.png`,
    ];

    for (const url of urls) {
      expect(
        assetImageCacheKey(
          environmentId,
          { _tag: "github-media", cwd: "/repo", url },
          { accessScope: "a" },
        ),
        url,
      ).toBeUndefined();
    }
  });

  it("keys host files by the version the server read, and by URL without one", () => {
    const resource = {
      _tag: "media-file",
      threadId: ThreadId.make("thread-1"),
      path: "/tmp/shot.png",
    } as const;
    const first = assetImageCacheKey(environmentId, resource, { fileRevision: "5:1000" });

    expect(first).toBeDefined();
    expect(assetImageCacheKey(environmentId, resource, { fileRevision: "5:1000" })).toBe(first);
    expect(assetImageCacheKey(environmentId, resource, { fileRevision: "5:2000" })).not.toBe(first);
    expect(assetImageCacheKey(environmentId, resource)).toBeUndefined();
  });
});
