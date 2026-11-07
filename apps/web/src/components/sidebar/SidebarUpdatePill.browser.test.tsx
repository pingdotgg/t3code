import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render, stubGlobal } from "../../../test/render";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    hasUpdates: false,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: (await import("react")).useSyncExternalStore.bind(
    null,
    mocks.subscribe,
    () => mocks.update,
  ),
}));
// The pill only renders in the desktop app.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("./useUpdateEverything", () => ({
  useUpdateEverything: () => ({
    hasUpdates: mocks.hasUpdates,
    summary: "Update everything",
    version: null,
    providerCount: 0,
    rows: [],
    restarts: [],
  }),
}));

function nightlyUpdate(releaseNotes: DesktopUpdateState["releaseNotes"]): DesktopUpdateState {
  return {
    enabled: true,
    status: "available",
    channel: "nightly",
    currentVersion: "0.0.50-nightly.1",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.50-nightly.2",
    downloadedVersion: null,
    releaseNotes,
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

const RELEASE_NOTES: DesktopUpdateState["releaseNotes"] = [
  { version: "0.0.50-nightly.2", items: ["Faster sidebar."], totalItems: 1 },
];

function setup(update: DesktopUpdateState | null, { hasUpdates = false } = {}) {
  mocks.update = update;
  mocks.hasUpdates = hasUpdates;
}

function publish(update: DesktopUpdateState | null) {
  return act(() => {
    mocks.update = update;
    mocks.notify();
  });
}

const releaseNotes = () => document.querySelector('[aria-label="Update release notes"]');

describe("SidebarUpdatePill manual checks", () => {
  it.each(["success", "failure"] as const)(
    "finishes the manual rotation after %s and keeps automatic checks static",
    async (outcome) => {
      const idle: DesktopUpdateState = {
        ...nightlyUpdate([]),
        status: "idle",
        availableVersion: null,
      };
      setup(idle);
      const check = Promise.withResolvers<Awaited<ReturnType<DesktopBridge["checkForUpdate"]>>>();
      using _bridge = stubGlobal("desktopBridge", { checkForUpdate: () => check.promise });
      await using screen = await render(<SidebarUpdatePill />);
      const button = screen.getByRole("button", { name: "Check for updates" }).element();

      await publish({ ...idle, status: "checking" });
      expect(button.querySelector('[class*="visible-animate-spin"]')).toBeNull();
      expect(button.getAttribute("aria-disabled")).toBe("true");
      await publish(idle);

      await userEvent.click(button);
      const spinner = button.querySelector<SVGSVGElement>('[class*="visible-animate-spin"]');
      expect(spinner).not.toBeNull();
      // Drive rotation boundaries explicitly so the IPC response cannot race the browser's animation.
      spinner!.style.animationPlayState = "paused";
      await publish({ ...idle, status: "checking" });
      await act(() =>
        spinner!.dispatchEvent(new AnimationEvent("animationiteration", { bubbles: true })),
      );
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.contains(spinner)).toBe(true);

      await act(async () => {
        mocks.update = idle;
        mocks.notify();
        if (outcome === "success") check.resolve({ checked: true, state: idle });
        else check.reject(new Error("Update check failed"));
        await check.promise.catch(() => undefined);
      });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.contains(spinner)).toBe(true);

      await act(() =>
        spinner!.dispatchEvent(new AnimationEvent("animationiteration", { bubbles: true })),
      );
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.querySelector('[class*="visible-animate-spin"]')).toBeNull();
      const returnIcon = button.querySelector(".lucide-circle-arrow-up");
      expect(returnIcon).not.toBeNull();
      await act(() =>
        returnIcon!.dispatchEvent(
          new AnimationEvent("animationend", {
            animationName: "desktop-update-check-incoming",
            bubbles: true,
          }),
        ),
      );
      expect(button.hasAttribute("aria-disabled")).toBe(false);

      await publish({ ...idle, status: "checking" });
      expect(button.querySelector('[class*="visible-animate-spin"]')).toBeNull();
    },
  );

  it("finishes immediately with reduced motion", async () => {
    const idle: DesktopUpdateState = {
      ...nightlyUpdate([]),
      status: "idle",
      availableVersion: null,
    };
    setup(idle);
    const matchMedia = window.matchMedia.bind(window);
    using _media = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const result = matchMedia(query);
      if (query === "(prefers-reduced-motion: reduce)") {
        Object.defineProperty(result, "matches", { value: true });
      }
      return result;
    });
    const check = Promise.withResolvers<Awaited<ReturnType<DesktopBridge["checkForUpdate"]>>>();
    using _bridge = stubGlobal("desktopBridge", { checkForUpdate: () => check.promise });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Check for updates" }).element();
    await userEvent.click(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.querySelector('[class*="visible-animate-spin"]')).toBeNull();

    await act(async () => {
      check.resolve({ checked: true, state: idle });
      await check.promise;
    });
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("SidebarUpdatePill release notes", () => {
  it("closes when the release notes stop applying", async () => {
    setup(nightlyUpdate(RELEASE_NOTES));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());

    await publish(nightlyUpdate([]));
    await vi.waitFor(() => expect(releaseNotes()).toBeNull());
  });

  it("opens when release notes arrive while the trigger has keyboard focus", async () => {
    setup(nightlyUpdate([]));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    expect(releaseNotes()).toBeNull();

    await publish(
      nightlyUpdate([
        {
          version: "0.0.50-nightly.2",
          items: ["**One-time tasks.** Pick a date."],
          totalItems: 1,
          stats: "3 changes from 2 contributors",
          footer: "Plus 2 more bug fixes.",
        },
      ]),
    );
    await expect.element(page.getByText("One-time tasks.", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Plus 2 more bug fixes.")).toBeVisible();
  });
});

describe("SidebarUpdatePill downloads", () => {
  it("finishes the progress ring while making restart available", async () => {
    const downloading: DesktopUpdateState = {
      ...nightlyUpdate([]),
      status: "downloading",
      downloadPercent: 95,
    };
    setup(downloading);
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Downloading update (95%)" }).element();
    const progress = button.querySelector<SVGCircleElement>("circle[stroke-dasharray]")!;
    const ring = progress.parentElement!;
    expect(getComputedStyle(ring).opacity).toBe("1");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // Hold the transition until assertions finish, independent of the browser's frame timing.
    for (const element of button.querySelectorAll<HTMLElement | SVGElement>("span, svg, circle")) {
      element.style.transitionDuration = "600s";
      element.style.transitionDelay = "0s";
    }

    const downloaded: DesktopUpdateState = {
      ...downloading,
      status: "downloaded",
      downloadPercent: null,
      downloadedVersion: downloading.availableVersion,
    };
    await publish(downloaded);
    expect(button.getAttribute("aria-label")).toContain("Click to restart and install");
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.contains(progress)).toBe(true);
    const transitions = button.getAnimations({ subtree: true });
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.every((transition) => transition.effect?.getTiming().iterations === 1)).toBe(
      true,
    );

    for (const transition of transitions) transition.finish();
    await Promise.all(transitions.map((transition) => transition.finished));
    expect(getComputedStyle(ring).opacity).toBe("0");
    expect(button.getAnimations({ subtree: true })).toHaveLength(0);
    await publish({ ...downloaded });
    expect(button.getAnimations({ subtree: true })).toHaveLength(0);
  });
});

describe("SidebarUpdatePill update everything", () => {
  it("does not refocus the update button after a pointer cancel", async () => {
    setup(null, { hasUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Update everything" });
    await userEvent.click(button);
    const cancel = page.getByRole("button", { name: "Cancel" });
    await expect.element(cancel).toBeVisible();

    await userEvent.click(cancel);
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(document.activeElement).not.toBe(button.element());
  });

  it("returns focus to the update button after Escape", async () => {
    setup(null, { hasUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Update everything" });
    await userEvent.click(button);
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(button.element()));
  });
});
