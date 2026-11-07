import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { ChatMarkdownAssetImage, WorkspaceMutationIdContext } from "./ChatMarkdownMedia";

// Every evaluation of the URL query is one mint: the first read, then one per refresh.
const assetQuery = vi.hoisted(() => ({ mints: 0 }));
vi.mock(import("~/state/assets"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const createUrl = Atom.family((_key: string) =>
    Atom.make(() => {
      assetQuery.mints += 1;
      return AsyncResult.success({
        relativeUrl: _key.includes(".mp4")
          ? `/asset/clip.mp4#${assetQuery.mints}`
          : `data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7#${assetQuery.mints}`,
        expiresAt: Number.MAX_SAFE_INTEGER,
        fileRevision: String(assetQuery.mints),
      });
    }).pipe(Atom.keepAlive),
  );
  const actual = await original();
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: (target: { readonly input: unknown }) => createUrl(JSON.stringify(target.input)),
    },
  };
});
vi.mock(import("~/state/session"), async (original) => {
  const { Option } = await import("effect");
  const { PrimaryConnectionTarget } = await import("@t3tools/client-runtime/connection");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Local",
    httpBaseUrl: "http://localhost:1",
    wsBaseUrl: "ws://localhost:1",
  });
  const prepared: PreparedConnection = {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: target.wsBaseUrl,
    httpAuthorization: null,
    target,
  };
  return {
    ...(await original()),
    usePreparedConnection: () => Option.some(prepared),
  };
});
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));

function setup() {
  assetQuery.mints = 0;
}

describe("ChatMarkdownAssetImage", () => {
  it.each(["image", "video"] as const)(
    "refreshes repeated local %s embeds together after a new chat revision",
    async (kind) => {
      setup();
      using _observer = stubGlobal(
        "IntersectionObserver",
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      const images = (revision: string) => (
        <WorkspaceMutationIdContext value={revision}>
          {["first", "second"].map((alt) => (
            <ChatMarkdownAssetImage
              key={alt}
              kind={kind}
              environmentId={EnvironmentId.make("environment-1")}
              resource={{
                _tag: "media-file",
                threadId: ThreadId.make("thread-1"),
                path: `/tmp/render.${kind === "video" ? "mp4" : "png"}`,
              }}
              alt={alt}
            />
          ))}
        </WorkspaceMutationIdContext>
      );
      await using screen = await render(images("message-1"));
      using errors = vi.spyOn(console, "error");
      await vi.waitFor(() => expect(assetQuery.mints).toBe(2));
      const previousSrc = (
        kind === "image"
          ? screen.getByRole("img", { name: "first" })
          : screen.getByLabelText("first", { exact: true })
      )
        .element()
        .getAttribute("src");

      if (kind === "video") {
        await act(() => {
          for (const video of document.querySelectorAll("video")) {
            video.dispatchEvent(new Event("loadedmetadata"));
          }
        });
      }

      await screen.rerender(images("message-2"));
      await vi.waitFor(() => expect(assetQuery.mints).toBe(3));
      const first =
        kind === "image"
          ? screen.getByRole("img", { name: "first" })
          : screen.getByLabelText("first", { exact: true });
      const second =
        kind === "image"
          ? screen.getByRole("img", { name: "second" })
          : screen.getByLabelText("second", { exact: true });
      await expect.element(first).not.toHaveAttribute("src", previousSrc);
      await expect.element(second).toHaveAttribute("src", first.element().getAttribute("src"));
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it("does not re-mint an unchanged workspace image's URL on remount", async () => {
    setup();
    const image = (
      <ChatMarkdownAssetImage
        environmentId={EnvironmentId.make("environment-1")}
        resource={{
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: "docs/diagram.png",
        }}
        alt="diagram"
        workspaceMutationId="mutation-1"
      />
    );

    {
      await using screen = await render(image);
      await expect.element(screen.getByRole("img", { name: "diagram" })).toBeInTheDocument();
    }
    // The first mount at a known revision re-mints the cached URL once.
    expect(assetQuery.mints).toBe(2);

    await using screen = await render(<ChatMarkdownAssetImage {...image.props} />);
    await expect.element(screen.getByRole("img", { name: "diagram" })).toBeInTheDocument();
    expect(assetQuery.mints).toBe(2);
  });
});
