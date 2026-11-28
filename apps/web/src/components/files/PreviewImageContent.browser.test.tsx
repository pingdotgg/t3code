import type { ClientSettings } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import "~/index.css";
import {
  __resetClientSettingsPersistenceForTests,
  updateClientSettings,
} from "~/hooks/useSettings";
import { I18nProvider } from "~/i18n/I18nProvider";
import { initializeI18n } from "~/i18n/initializeI18n";
import { startI18n, whenLocaleReady } from "~/i18n/runtime";
import { ensureLocalApi } from "~/localApi";
import PreviewImageContent from "./PreviewImageContent";

function png(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.toDataURL("image/png");
}

it("fits the image inside a pane with a fractional width", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;width:500.5px;height:600px";
  await using _screen = await render(
    <PreviewImageContent src={png(1600, 900)} name="wide.png" mimeType="image/png" />,
    { container: host },
  );
  const image = host.querySelector("img")!;
  const padding = 32;

  await vi.waitFor(() => {
    const width = image.getBoundingClientRect().width + padding;
    expect(width).toBeGreaterThan(499.5);
    expect(width).toBeLessThanOrEqual(500.5);
  });
});

it("keeps a cached image out of view until it is fitted", async () => {
  const src = png(1600, 900);
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;width:500px;height:600px";
  const image = () => host.querySelector("img");
  await using screen = await render(
    <PreviewImageContent key="first" src={src} name="wide.png" mimeType="image/png" />,
    { container: host },
  );
  await vi.waitFor(() => expect(image()?.getBoundingClientRect().width).toBeGreaterThan(400));

  // A new key remounts the preview, as a new file revision does. The cached image has its natural
  // size on insertion, and the observer measures it before the load event can fit it.
  let insertedWidth: number | undefined;
  const mounts = new MutationObserver(() => {
    insertedWidth ??= image()?.getBoundingClientRect().width;
  });
  mounts.observe(host, { childList: true, subtree: true });
  await screen.rerender(
    <PreviewImageContent key="second" src={src} name="wide.png" mimeType="image/png" />,
  );
  mounts.disconnect();

  expect(insertedWidth).toBeLessThanOrEqual(500);
  await vi.waitFor(() => expect(image()?.getBoundingClientRect().width).toBeGreaterThan(400));
});

it("groups the image size in the app language, not the browser's", async () => {
  const { persistence } = ensureLocalApi();
  let savedSettings: ClientSettings | null = null;
  using _readSettings = vi
    .spyOn(persistence, "getClientSettings")
    .mockImplementation(async () => savedSettings);
  using _writeSettings = vi
    .spyOn(persistence, "setClientSettings")
    .mockImplementation(async (settings) => {
      savedSettings = settings;
    });
  __resetClientSettingsPersistenceForTests();
  const setLanguage = async (language: string) => {
    await act(async () => {
      await updateClientSettings({ language });
      await whenLocaleReady();
    });
  };
  try {
    startI18n();
    await setLanguage("de");
    const host = document.createElement("div");
    host.style.cssText = "display:flex;flex-direction:column;width:500px;height:600px";
    await using _screen = await render(
      <I18nProvider>
        <PreviewImageContent src={png(1600, 900)} name="wide.png" mimeType="image/png" />
      </I18nProvider>,
      { container: host },
    );
    await vi.waitFor(() => expect(host.textContent).toContain("1.600 × 900"));
  } finally {
    await setLanguage("en");
    __resetClientSettingsPersistenceForTests();
    // Restore the GT fallback locale for tests that render without an I18nProvider.
    initializeI18n(() => {});
  }
});
