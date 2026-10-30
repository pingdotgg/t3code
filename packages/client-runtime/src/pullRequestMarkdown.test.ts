import { describe, expect, it } from "vite-plus/test";

import {
  changeRequestLinkResolver,
  changeRequestReferenceAutolinker,
  splitPullRequestBody,
} from "./pullRequestMarkdown.ts";

describe("pull request body segmentation", () => {
  // GitHub writes a dropped image into the body as an `<img>` tag, so a bare attachment link on
  // its own line is the shape it uses for a video — every one sampled in the wild was one.
  it("lifts a dropped video out and keeps the prose around it", () => {
    expect(
      splitPullRequestBody(
        "Before\n\nhttps://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456\n\nAfter",
      ),
    ).toEqual([
      { id: "markdown:0", kind: "markdown", text: "Before" },
      {
        id: "attachment:1",
        kind: "attachment",
        url: "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456",
        media: "video",
      },
      { id: "markdown:2", kind: "markdown", text: "After" },
    ]);
  });

  it("reads the source out of a video tag, including a multi-line one", () => {
    expect(
      splitPullRequestBody(
        '<video controls>\n  <source src="https://example.com/a.webm">\n</video>',
      ),
    ).toEqual([
      {
        id: "attachment:0",
        kind: "attachment",
        url: "https://example.com/a.webm",
        media: "video",
      },
    ]);
  });

  it("leaves the img tag GitHub writes for a dropped image as markdown", () => {
    const body =
      '<img width="1414" alt="image" src="https://github.com/user-attachments/assets/7195f963-51a9-4331-be74-3e06be760422" />';
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("leaves an ordinary link alone, whether it is bare or written as markdown", () => {
    const body = "https://example.com/page\n\n[the docs](https://example.com/docs)";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("never lifts a link inside fenced code out of it", () => {
    const body = "```\nhttps://example.com/demo.mp4\n```";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("does not let a different fence marker close an open fence", () => {
    const body = "```\n~~~\nhttps://example.com/demo.mp4\n```";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("keeps a video tag that shares its line with prose as markdown", () => {
    const body = 'Before <video src="https://example.com/a.mp4"></video> after';
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("treats an info-string fence as a nested opener, not a close", () => {
    const body = "```\n```javascript\nhttps://example.com/demo.mp4\n```";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("leaves an indented code line alone even when it is only a video link", () => {
    const body = "    https://example.com/demo.mp4";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("leaves an unclosed video tag as prose without eating the rest of the body", () => {
    const body = ['<video src="https://example.com/a.mp4">', "still prose", "more prose"].join(
      "\n",
    );
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });

  it("refuses a non-http source rather than making a link out of it", () => {
    const body = '<video src="javascript:alert(1)"></video>';
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });
});

describe("media on custom hosts", () => {
  it.each([
    ["https://drop.example.com/capture.PNG?token=abc#preview", "image"],
    ["[Recording](https://drop.example.com/recording.mov)", "video"],
    ["<https://drop.example.com/shot.webp>", "image"],
  ])("recognizes %s without a request", (body, media) => {
    expect(splitPullRequestBody(body)).toEqual([
      expect.objectContaining({ kind: "attachment", media }),
    ]);
  });

  it("keeps inline links and media examples in code as prose", () => {
    const body =
      "See [recording](https://drop.example.com/a.mp4) for context.\n\n```md\nhttps://drop.example.com/a.png\n```";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });
});

describe("change request reference autolinks", () => {
  const urls = (provider: string, url: string, text: string) =>
    changeRequestReferenceAutolinker({ provider, url })?.(text).map((link) => link.url) ?? null;

  it("links references against the change request's own repository", () => {
    expect(urls("github", "https://ghe.example.com/acme/web/pull/7", "Fixes #5")).toEqual([
      "https://ghe.example.com/acme/web/issues/5",
    ]);
  });

  // regression: the mobile review guide linked every host's `#5` with GitHub's grammar
  it("links nothing on a host whose grammar is not applied", () => {
    expect(urls("gitlab", "https://gitlab.com/group/project/-/merge_requests/7", "#5")).toBeNull();
    expect(urls("forgejo", "https://codeberg.org/acme/web/pulls/7", "#5")).toBeNull();
  });
});

describe("change request relative links", () => {
  const upload = "/uploads/66dbcd21ec5d24ed6ea225176098d52b/shot.png";

  it("resolves a GitLab upload against the merge request's project", () => {
    const resolve = changeRequestLinkResolver({
      provider: "gitlab",
      url: "https://gitlab.example.com/group/Sub/app/-/merge_requests/7",
    });
    expect(resolve?.(`![shot](${upload})`)).toBe(
      `![shot](https://gitlab.example.com/group/Sub/app${upload})`,
    );
  });

  it("leaves bodies alone on a host that writes no relative links", () => {
    expect(
      changeRequestLinkResolver({ provider: "github", url: "https://github.com/acme/web/pull/7" }),
    ).toBeNull();
  });
});
