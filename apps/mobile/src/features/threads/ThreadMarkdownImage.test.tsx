import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  failImage: () => {},
  Passthrough: ({ children }: { children?: unknown }) => children,
}));

vi.mock("react-native", () => ({
  Pressable: harness.Passthrough,
  StyleSheet: { absoluteFill: {} },
  View: harness.Passthrough,
}));
vi.mock("expo-image", () => ({
  Image: (props: { onError: () => void }) => {
    harness.failImage = props.onError;
    return <img alt="" />;
  },
}));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("react-native-svg", () => ({ parse: vi.fn(), SvgAst: () => null }));
vi.mock("@t3tools/client-runtime/state/assets", () => ({ MISSING_FILE_ACCESS_MESSAGE: "" }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/FilePreviewGallery", () => ({
  useFilePreviewGallery: () => (source: unknown) => source,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/MediaActionsMenu", () => ({ MediaActionsMenu: harness.Passthrough }));
vi.mock("../../components/ui/NativePresentation", () => ({
  PresentationSource: harness.Passthrough,
}));
vi.mock("../../state/mediaActions", () => ({ useMediaActions: () => ({ actions: [] }) }));
vi.mock("../../state/assets", () => ({ useAssetUrlState: vi.fn() }));

import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { fetch } from "expo/fetch";
import { parse } from "react-native-svg";

import { ThreadMarkdownImageView } from "./ThreadMarkdownImage";

it("retries a failed image once its URI comes back through null", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const view = (uri: string | null) => (
    <ThreadMarkdownImageView
      uri={uri}
      sourceKey="attachment:a"
      unavailable={false}
      alt={null}
      onPressPreview={() => {}}
    />
  );
  try {
    await act(async () => root.render(view("https://example.test/a.png")));
    await act(async () => harness.failImage());
    expect(container.textContent).toContain("Image unavailable");

    await act(async () => root.render(view(null)));
    await act(async () => root.render(view("https://example.test/a.png")));
    expect(container.textContent).not.toContain("Image unavailable");
    expect(container.querySelector("img")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("fetches a failed SVG again on the next mount but keeps a parsed one", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Microtask scheduling lets act() flush an unmounted atom's removal before the next render.
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      queueMicrotask(task);
      return () => {};
    },
  });
  const fetchSvg = vi.mocked(fetch);
  vi.mocked(parse).mockReturnValue({ props: {} } as ReturnType<typeof parse>);
  const container = document.createElement("div");
  const root = createRoot(container);
  const uri = "https://example.test/a.svg";
  const view = (mounted: boolean) => (
    <RegistryContext.Provider value={registry}>
      {mounted ? (
        <ThreadMarkdownImageView
          uri={uri}
          sourceKey="attachment:svg"
          unavailable={false}
          alt={null}
          format="svg"
          onPressPreview={() => {}}
        />
      ) : null}
    </RegistryContext.Provider>
  );
  try {
    fetchSvg.mockRejectedValueOnce(new Error("offline"));
    await act(async () => root.render(view(true)));
    await vi.waitFor(() => expect(container.textContent).toContain("Image unavailable"));

    await act(async () => root.render(view(false)));
    fetchSvg.mockResolvedValue({ ok: true, status: 200, text: async () => "<svg />" } as never);
    await act(async () => root.render(view(true)));
    await vi.waitFor(() => expect(container.textContent).not.toContain("Image unavailable"));
    expect(fetchSvg).toHaveBeenCalledTimes(2);

    await act(async () => root.render(view(false)));
    await act(async () => root.render(view(true)));
    expect(container.textContent).not.toContain("Image unavailable");
    expect(fetchSvg).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
  }
});
