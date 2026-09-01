import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: () => ({ _tag: "Success", url: "https://signed.test/image.png" }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown, {
  markdownImageGalleryPreview,
  registerMarkdownGalleryImage,
} from "./ChatMarkdown";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

/** Elements sharing one message scope, in document order. */
function fakeGalleryElements(count: number): Element[] {
  const elements: Array<Record<string, unknown>> = [];
  const scope = { querySelectorAll: () => elements };
  for (let position = 0; position < count; position += 1) {
    elements.push({ closest: () => scope });
  }
  return elements as unknown as Element[];
}

describe("markdownImageGalleryPreview", () => {
  it("collects registered sibling images in document order around the clicked one", () => {
    const [first, second, third] = fakeGalleryElements(3);
    registerMarkdownGalleryImage(first!, { src: "blob:1", name: "one" });
    registerMarkdownGalleryImage(second!, {
      src: "https://signed.test/2.png",
      name: "two",
      actionsSource: { kind: "image", name: "2.png", src: "https://signed.test/2.png" },
    });
    registerMarkdownGalleryImage(third!, { src: "data:image/png;base64,AA", name: "three" });

    const preview = markdownImageGalleryPreview(third!, {
      src: "data:image/png;base64,AA",
      name: "three",
    });

    expect(preview.index).toBe(2);
    expect(preview.images.map((image) => image.name)).toEqual(["one", "two", "three"]);
    expect(preview.images[1]).toMatchObject({
      src: "https://signed.test/2.png",
      actionsSource: { kind: "image" },
    });
    expect(markdownImageGalleryPreview(first!, { src: "blob:1", name: "one" }).index).toBe(0);
  });

  it("skips unregistered siblings while keeping the clicked index correct", () => {
    const [first, , third] = fakeGalleryElements(3);
    registerMarkdownGalleryImage(first!, { src: "blob:1", name: "one" });

    const preview = markdownImageGalleryPreview(third!, { src: "blob:3", name: "three" });

    expect(preview).toEqual({
      images: [
        { src: "blob:1", name: "one" },
        { src: "blob:3", name: "three" },
      ],
      index: 1,
    });
  });

  it("falls back to a single image outside a message body", () => {
    const orphan = { closest: () => null } as unknown as Element;

    expect(markdownImageGalleryPreview(orphan, { src: "blob:solo", name: "solo" })).toEqual({
      images: [{ src: "blob:solo", name: "solo" }],
      index: 0,
    });
  });
});

describe("ChatMarkdown gallery membership", () => {
  it("marks each preview-enabled image as a gallery member", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/workspace/project"
        threadRef={threadRef}
        text={"![one](https://example.com/1.png)\n\n![two](https://example.com/2.png)"}
        onImageExpand={() => {}}
      />,
    );

    expect(html.match(/data-preview-image/g)).toHaveLength(2);
  });

  it("keeps link favicons and linked images out of the gallery", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/workspace/project"
        threadRef={threadRef}
        text={
          "[![linked](https://example.com/1.png)](https://example.com) [site](https://example.com)"
        }
        onImageExpand={() => {}}
      />,
    );

    expect(html).not.toContain("data-preview-image");
  });
});
