import { describe, expect, it } from "vite-plus/test";

import { pullRequestMarkdownPreview, splitPullRequestBody } from "./pullRequestMarkdown.logic";

describe("pull request body segmentation", () => {
  it("keeps a plain body as a single markdown run", () => {
    expect(splitPullRequestBody("## What changed\n\nSome prose.")).toEqual([
      { id: "markdown:0", kind: "markdown", text: "## What changed\n\nSome prose." },
    ]);
  });

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

  it("names a bare link to a video file a video", () => {
    expect(splitPullRequestBody("https://example.com/demo.mp4?raw=1")).toEqual([
      {
        id: "attachment:0",
        kind: "attachment",
        url: "https://example.com/demo.mp4?raw=1",
        media: "video",
      },
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

  it("leaves a dropped image as markdown so it still renders as an image", () => {
    const body = "![shot](https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-ab)";
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
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

  it("keeps the indentation that opens a code block", () => {
    const body = "    const answer = 42;";
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

  it("stays linear when the body is full of unclosed video tags", () => {
    const body = Array.from(
      { length: 4_000 },
      () => '<video src="https://example.com/a.mp4">',
    ).join("\n");
    const startedAt = performance.now();
    expect(splitPullRequestBody(body)).toHaveLength(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("refuses a non-http source rather than making a link out of it", () => {
    const body = '<video src="javascript:alert(1)"></video>';
    expect(splitPullRequestBody(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body },
    ]);
  });
});

describe("resolved mention previews", () => {
  it.each(["```\n[!NOTE]\n```", "    [!NOTE]", "`[!NOTE]`"])(
    "preserves literal alert markers in code: %s",
    (body) => expect(pullRequestMarkdownPreview(body)).toBe("[!NOTE]"),
  );
  it.each(["<br>", "<br/>", "<BR />", '<br title="break">', '<br title="a > b">'])(
    "separates words across HTML breaks: %s",
    (tag) => expect(pullRequestMarkdownPreview(`Review:${tag}@Alex`)).toBe("Review: @Alex"),
  );
  it("hides alert markers just like unresolved comment previews", () => {
    expect(pullRequestMarkdownPreview("> [!NOTE]\n> @Alex Smith done")).toBe("@Alex Smith done");
  });
  it.each(["@Alex  \nplease review", "@Alex\\\nplease review"])(
    "separates words across hard breaks in %s",
    (body) => expect(pullRequestMarkdownPreview(body)).toBe("@Alex please review"),
  );
  it("preserves literal Markdown characters in names", () => {
    expect(pullRequestMarkdownPreview("@Jane\\_Smith @A\\[B\\]\\*\\`\\\\")).toBe(
      "@Jane_Smith @A[B]*`\\",
    );
  });

  it("separates blocks and keeps links and code readable", () => {
    expect(
      pullRequestMarkdownPreview(
        "First paragraph\n\n- [Alex](https://example.com)\n- `@{literal}`\n\n<!-- hidden -->\nLast paragraph",
      ),
    ).toBe("First paragraph Alex @{literal} Last paragraph");
  });
});
