// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { runPreviewClickKeepingHostFocus } from "./previewClickFocus";

const TAB = "runtime-tab";

const mount = (tagName: string, previewTab?: string) => {
  const element = document.createElement(tagName);
  element.tabIndex = -1;
  if (previewTab) element.setAttribute("data-preview-tab", previewTab);
  document.body.append(element);
  return element;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("runPreviewClickKeepingHostFocus", () => {
  it("gives focus back to the composer after the click focuses the page", async () => {
    const composer = mount("textarea");
    const webview = mount("webview", TAB);
    composer.focus();

    const result = await runPreviewClickKeepingHostFocus(TAB, async () => {
      webview.focus();
      return "clicked";
    });

    expect(result).toBe("clicked");
    expect(document.activeElement).toBe(composer);
  });

  it("gives focus back when the user's typing interrupts the click", async () => {
    const composer = mount("textarea");
    const webview = mount("webview", TAB);
    composer.focus();
    const interrupted = new Error("PreviewAutomationControlInterruptedError");

    await expect(
      runPreviewClickKeepingHostFocus(TAB, async () => {
        webview.focus();
        throw interrupted;
      }),
    ).rejects.toBe(interrupted);

    expect(document.activeElement).toBe(composer);
  });

  it("gives focus back once overlapping clicks in two tabs finish", async () => {
    const composer = mount("textarea");
    const first = mount("webview", TAB);
    const second = mount("webview", "other-tab");
    composer.focus();
    let finishSecond = () => {};

    const firstClick = runPreviewClickKeepingHostFocus(TAB, async () => {
      first.focus();
    });
    // Starts while the first click holds focus in its page, and finishes last.
    const secondClick = runPreviewClickKeepingHostFocus("other-tab", async () => {
      second.focus();
      await new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
    });
    await firstClick;
    finishSecond();
    await secondClick;

    expect(document.activeElement).toBe(composer);
  });

  it("keeps the user's page when overlapping clicks finish in reverse order", async () => {
    const first = mount("webview", TAB);
    const second = mount("webview", "other-tab");
    second.focus();
    let finishFirst = () => {};

    const firstClick = runPreviewClickKeepingHostFocus(TAB, async () => {
      first.focus();
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    });
    // Starts while the first click holds focus in its page, and finishes first.
    await runPreviewClickKeepingHostFocus("other-tab", async () => {
      second.focus();
    });
    finishFirst();
    await firstClick;

    expect(document.activeElement).toBe(second);
  });

  it("ignores a click that never finishes", async () => {
    const composer = mount("textarea");
    const stuck = mount("webview", "stuck-tab");
    const webview = mount("webview", TAB);
    const other = mount("webview", "other-tab");
    composer.focus();

    // A click queued behind a page promise that never settles.
    void runPreviewClickKeepingHostFocus("stuck-tab", () => new Promise<never>(() => {}));
    await runPreviewClickKeepingHostFocus(TAB, async () => {
      webview.focus();
    });
    expect(document.activeElement).toBe(composer);

    // The user opens the stuck tab's page themselves.
    stuck.focus();
    await runPreviewClickKeepingHostFocus("other-tab", async () => {
      other.focus();
    });
    expect(document.activeElement).toBe(stuck);
  });

  it("leaves no focus in the page when the composer can no longer take focus", async () => {
    const composer = mount("div");
    const webview = mount("webview", TAB);
    composer.focus();

    await runPreviewClickKeepingHostFocus(TAB, async () => {
      webview.focus();
      // Like the editor going read-only for an approval request.
      composer.removeAttribute("tabindex");
    });

    expect(document.activeElement).toBe(document.body);
  });

  it("leaves no focus in the page when nothing in the app had focus", async () => {
    const webview = mount("webview", TAB);

    await runPreviewClickKeepingHostFocus(TAB, async () => {
      webview.focus();
    });

    expect(document.activeElement).toBe(document.body);
  });

  it("keeps focus in the page when the user was already typing there", async () => {
    const webview = mount("webview", TAB);
    webview.focus();

    await runPreviewClickKeepingHostFocus(TAB, async () => undefined);

    expect(document.activeElement).toBe(webview);
  });
});
