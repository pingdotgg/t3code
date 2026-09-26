import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  COMPOSER_MENTION_DRAG_TYPE,
  dragMentionPayload,
  fileBreadcrumbChildren,
  fileBreadcrumbParent,
  fileBreadcrumbs,
  isAbsolutePath,
  lineStartOffset,
  resolveCenteredFileLineScrollTop,
  resolveWorkspaceLink,
  splitFilePathPosition,
} from "./fileNavigation.ts";

const entries = [
  { path: "src", kind: "directory" },
  { path: "src/lib", kind: "directory" },
  { path: "src/app.ts", kind: "file" },
  { path: "src/lib/deep.ts", kind: "file" },
  { path: "README.md", kind: "file" },
  { path: "docs", kind: "directory" },
];

NodeTest.describe("file navigation helpers", () => {
  NodeTest.describe("isAbsolutePath", () => {
    NodeTest.it("recognizes posix, drive, and UNC roots", () => {
      NodeAssert.equal(isAbsolutePath("/etc/hosts"), true);
      NodeAssert.equal(isAbsolutePath("C:\\src\\app.ts"), true);
      NodeAssert.equal(isAbsolutePath("C:/src/app.ts"), true);
      NodeAssert.equal(isAbsolutePath("\\\\server\\share"), true);
      NodeAssert.equal(isAbsolutePath("docs/guide.md"), false);
      NodeAssert.equal(isAbsolutePath("./x.md"), false);
      NodeAssert.equal(isAbsolutePath("\u007E/x.md"), false);
    });
  });

  NodeTest.describe("splitFilePathPosition", () => {
    NodeTest.it("splits a :line[:column] suffix", () => {
      NodeAssert.deepEqual(splitFilePathPosition("src/app.ts:12"), {
        path: "src/app.ts",
        line: 12,
      });
      NodeAssert.deepEqual(splitFilePathPosition("src/app.ts:12:3"), {
        path: "src/app.ts",
        line: 12,
        column: 3,
      });
    });

    NodeTest.it("splits a #L… / #L…C… hash", () => {
      NodeAssert.deepEqual(splitFilePathPosition("src/app.ts", "#L7"), {
        path: "src/app.ts",
        line: 7,
      });
      NodeAssert.deepEqual(splitFilePathPosition("src/app.ts", "#l7c4"), {
        path: "src/app.ts",
        line: 7,
        column: 4,
      });
    });

    NodeTest.it("ignores non-positions", () => {
      NodeAssert.deepEqual(splitFilePathPosition("src/app.ts"), { path: "src/app.ts" });
      NodeAssert.deepEqual(splitFilePathPosition("src/app.ts:0"), { path: "src/app.ts" });
      NodeAssert.deepEqual(splitFilePathPosition("src/app.ts", "#section"), {
        path: "src/app.ts",
      });
    });
  });

  NodeTest.describe("resolveWorkspaceLink", () => {
    NodeTest.it("joins relative hrefs onto the document's directory", () => {
      NodeAssert.deepEqual(resolveWorkspaceLink("b/c.md", "a"), {
        kind: "workspace",
        path: "a/b/c.md",
      });
      NodeAssert.deepEqual(resolveWorkspaceLink("./x.md", "a/b"), {
        kind: "workspace",
        path: "a/b/x.md",
      });
      NodeAssert.deepEqual(resolveWorkspaceLink("x.md", ""), {
        kind: "workspace",
        path: "x.md",
      });
    });

    NodeTest.it("resolves .. inside the workspace and rejects escapes", () => {
      NodeAssert.deepEqual(resolveWorkspaceLink("../x.md", "a/b"), {
        kind: "workspace",
        path: "a/x.md",
      });
      NodeAssert.deepEqual(resolveWorkspaceLink("../../x.md", "a"), { kind: "not-a-path" });
    });

    NodeTest.it("accepts the workspace root itself as a directory target", () => {
      NodeAssert.deepEqual(resolveWorkspaceLink("..", "docs"), {
        kind: "workspace",
        path: "",
      });
      NodeAssert.deepEqual(resolveWorkspaceLink(".", ""), {
        kind: "workspace",
        path: "",
      });
      NodeAssert.deepEqual(resolveWorkspaceLink("../..", "docs"), { kind: "not-a-path" });
      NodeAssert.deepEqual(resolveWorkspaceLink("..", ""), { kind: "not-a-path" });
    });

    NodeTest.it("carries line positions through", () => {
      NodeAssert.deepEqual(resolveWorkspaceLink("app.ts:12", "src"), {
        kind: "workspace",
        path: "src/app.ts",
        line: 12,
      });
      NodeAssert.deepEqual(resolveWorkspaceLink("app.ts#L4", "src"), {
        kind: "workspace",
        path: "src/app.ts",
        line: 4,
      });
    });

    NodeTest.it("decodes percent-encoded destinations", () => {
      NodeAssert.deepEqual(resolveWorkspaceLink("My%20File.md", "docs"), {
        kind: "workspace",
        path: "docs/My File.md",
      });
    });

    NodeTest.it("marks host paths external — the workspace root is unknown", () => {
      NodeAssert.deepEqual(resolveWorkspaceLink("/abs/x.ts", "docs"), {
        kind: "external",
        path: "/abs/x.ts",
      });
      NodeAssert.deepEqual(resolveWorkspaceLink("\u007E/x.ts", "docs"), {
        kind: "external",
        path: "\u007E/x.ts",
      });
      NodeAssert.deepEqual(resolveWorkspaceLink("C:\\x.ts", "docs"), {
        kind: "external",
        path: "C:\\x.ts",
      });
    });

    NodeTest.it("rejects non-path schemes but keeps :line suffixes", () => {
      NodeAssert.deepEqual(resolveWorkspaceLink("javascript:alert(1)", "docs"), {
        kind: "not-a-path",
      });
      NodeAssert.deepEqual(resolveWorkspaceLink("notes:12", "docs"), {
        kind: "workspace",
        path: "docs/notes",
        line: 12,
      });
    });

    NodeTest.it("resolves bare #L anchors to the current document", () => {
      NodeAssert.deepEqual(resolveWorkspaceLink("#L9", "docs"), { kind: "anchor", line: 9 });
      NodeAssert.deepEqual(resolveWorkspaceLink("#intro", "docs"), { kind: "anchor" });
    });
  });

  NodeTest.describe("fileBreadcrumbs", () => {
    NodeTest.it("starts at the root label for workspace paths", () => {
      NodeAssert.deepEqual(fileBreadcrumbs("Workspace", "docs/guide.md"), [
        { label: "Workspace", path: "", kind: "project" },
        { label: "docs", path: "docs", kind: "directory" },
        { label: "guide.md", path: "docs/guide.md", kind: "file" },
      ]);
    });

    NodeTest.it("omits the root crumb for absolute host paths", () => {
      NodeAssert.deepEqual(fileBreadcrumbs("Workspace", "/etc/hosts"), [
        { label: "etc", path: "/etc", kind: "directory" },
        { label: "hosts", path: "/etc/hosts", kind: "file" },
      ]);
    });

    NodeTest.it("keeps windows separators on windows paths", () => {
      NodeAssert.deepEqual(fileBreadcrumbs("Workspace", "C:\\a\\b.txt"), [
        { label: "C:", path: "C:", kind: "directory" },
        { label: "a", path: "C:\\a", kind: "directory" },
        { label: "b.txt", path: "C:\\a\\b.txt", kind: "file" },
      ]);
    });
  });

  NodeTest.describe("fileBreadcrumbChildren", () => {
    NodeTest.it("lists direct children, directories first", () => {
      NodeAssert.deepEqual(
        fileBreadcrumbChildren(entries, "src").map((child) => child.path),
        ["src/lib", "src/app.ts"],
      );
      NodeAssert.deepEqual(
        fileBreadcrumbChildren(entries, "").map((child) => child.path),
        ["docs", "src", "README.md"],
      );
    });

    NodeTest.it("skips deeper descendants", () => {
      NodeAssert.equal(
        fileBreadcrumbChildren(entries, "src").some((child) => child.path === "src/lib/deep.ts"),
        false,
      );
    });
  });

  NodeTest.it("fileBreadcrumbParent walks one segment up", () => {
    NodeAssert.equal(fileBreadcrumbParent("src/lib"), "src");
    NodeAssert.equal(fileBreadcrumbParent("src"), "");
    NodeAssert.equal(fileBreadcrumbParent(""), null);
  });

  NodeTest.describe("resolveCenteredFileLineScrollTop", () => {
    const base = {
      scrollTop: 0,
      scrollHeight: 4000,
      viewportTop: 100,
      viewportHeight: 400,
      fileTop: 0,
      estimatedLine: { top: 950, height: 20 },
    };

    NodeTest.it("centers the estimated line", () => {
      // (line top 950) - ((400 - 20) / 2) = 760
      NodeAssert.equal(resolveCenteredFileLineScrollTop(base), 760);
    });

    NodeTest.it("prefers rendered geometry", () => {
      NodeAssert.equal(
        resolveCenteredFileLineScrollTop({
          ...base,
          renderedLine: { top: 300, height: 30 },
        }),
        // rendered top relative to scroll: 0 + 300 - 100 = 200; center: 200 - 185 = 15
        15,
      );
    });

    NodeTest.it("clamps to the scroll range", () => {
      NodeAssert.equal(
        resolveCenteredFileLineScrollTop({
          ...base,
          estimatedLine: { top: 3990, height: 20 },
        }),
        3600,
      );
    });
  });

  NodeTest.it("lineStartOffset clamps into the text", () => {
    const text = "one\ntwo\nthree";
    NodeAssert.equal(lineStartOffset(text, 1), 0);
    NodeAssert.equal(lineStartOffset(text, 2), 4);
    NodeAssert.equal(lineStartOffset(text, 3), 8);
    NodeAssert.equal(lineStartOffset(text, 9), text.length);
  });

  NodeTest.describe("dragMentionPayload", () => {
    NodeTest.it("serializes the composer mention payload", () => {
      NodeAssert.equal(dragMentionPayload(["src/app.ts"]), "[app.ts](src/app.ts)");
      NodeAssert.equal(
        dragMentionPayload(["src/app.ts", "docs/guide.md"]),
        "[app.ts](src/app.ts) [guide.md](docs/guide.md)",
      );
    });

    NodeTest.it("strips directory trailing slashes and skips empties", () => {
      NodeAssert.equal(dragMentionPayload(["src/lib/"]), "[lib](src/lib)");
      NodeAssert.equal(dragMentionPayload(["/"]), null);
      NodeAssert.equal(dragMentionPayload([]), null);
    });

    NodeTest.it("uses the MIME the host composer claims", () => {
      NodeAssert.equal(COMPOSER_MENTION_DRAG_TYPE, "application/x-t3code-composer-mention");
    });
  });
});
