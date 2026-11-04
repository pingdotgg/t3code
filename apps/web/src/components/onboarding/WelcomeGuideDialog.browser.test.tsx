import { RegistryContext } from "@effect/atom-react";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  serverConfigs: new Map<string, unknown>(),
}));

// Side-chat support comes from the connected environments, which the test does not serve.
vi.mock(import("../../state/presentation"), async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await importOriginal();
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      serverConfigsAtom: Atom.make(() => state.serverConfigs) as never,
    },
  };
});
// The real keybindings watch environment connections the test does not serve.
vi.mock(import("../../state/server"), async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const { mergeWithDefaultKeybindings } = await import("@t3tools/shared/keybindings");
  return {
    ...(await importOriginal()),
    primaryServerKeybindingsAtom: Atom.make(mergeWithDefaultKeybindings([])),
  };
});

import { act, render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import {
  WELCOME_GUIDE_SEEN_STORAGE_KEY,
  WelcomeGuideHost,
  openWelcomeGuide,
} from "./WelcomeGuideDialog";

const EARLIER = "2026-01-02T03:04:05.000Z";
const NOW = "2026-10-26T12:00:00.000Z";

function setup({
  lessonSideChats = [false, true],
  seenAt = null,
  setupDone = true,
}: {
  readonly lessonSideChats?: ReadonlyArray<boolean>;
  readonly seenAt?: string | null;
  readonly setupDone?: boolean;
} = {}): Disposable {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: setupDone ? EARLIER : null,
  });
  state.serverConfigs = new Map(
    lessonSideChats.map((supported, index) => [
      `environment-${index}`,
      { environment: { capabilities: { lessonSideChats: supported }, serverVersion: "0.0.0" } },
    ]),
  );
  if (seenAt === null) localStorage.removeItem(WELCOME_GUIDE_SEEN_STORAGE_KEY);
  else localStorage.setItem(WELCOME_GUIDE_SEEN_STORAGE_KEY, JSON.stringify(seenAt));
  return { [Symbol.dispose]: () => localStorage.removeItem(WELCOME_GUIDE_SEEN_STORAGE_KEY) };
}

/** Fixes `Date` alone; the renderer and the assertions keep real timers. */
function systemTime(now: string): Disposable {
  vi.setSystemTime(new Date(now));
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}

// A fresh registry per test, so the capability atom reads this test's environments.
function mount({ hostedStatic = false }: { readonly hostedStatic?: boolean } = {}) {
  return render(
    <RegistryContext.Provider value={AtomRegistry.make()}>
      <WelcomeGuideHost hostedStatic={hostedStatic} />
    </RegistryContext.Provider>,
  );
}

const guide = () => page.getByRole("dialog", { name: "Welcome guide" });
const heading = (name: string) => page.getByRole("heading", { name });
const button = (name: string) => page.getByRole("button", { name, exact: true });
const storedSeenAt = () => localStorage.getItem(WELCOME_GUIDE_SEEN_STORAGE_KEY);

it("opens by itself after first-run setup when this device has not seen it and an environment has side chats", async () => {
  using _storage = setup();
  await using _screen = await mount();

  await expect.element(guide()).toBeVisible();
  await expect.element(heading("Welcome to T3 Learn")).toBeVisible();
  await expect.element(guide()).toHaveAccessibleDescription(/^Welcome to T3 Learn Every chat/);
  expect(storedSeenAt()).toBeNull();
});

it("waits for first-run setup before opening by itself", async () => {
  using _storage = setup({ setupDone: false });
  await using _screen = await mount();

  await expect.element(guide()).not.toBeInTheDocument();
});

it("opens by itself on the hosted app, which has no first-run setup", async () => {
  using _storage = setup({ setupDone: false });
  await using _screen = await mount({ hostedStatic: true });

  await expect.element(guide()).toBeVisible();
});

it("stays closed once this device has seen it", async () => {
  using _storage = setup({ seenAt: EARLIER });
  await using _screen = await mount();

  await expect.element(guide()).not.toBeInTheDocument();
});

it("stays closed, and unseen, while no environment supports side chats", async () => {
  using _storage = setup({ lessonSideChats: [false] });
  await using _screen = await mount();

  await expect.element(guide()).not.toBeInTheDocument();
  expect(storedSeenAt()).toBeNull();
});

it("moves through the steps and records the visit when the learner finishes", async () => {
  using _storage = setup();
  await using _screen = await mount();
  using _clock = systemTime(NOW);

  await expect.element(heading("Welcome to T3 Learn")).toBeVisible();
  await expect.element(button("Back")).not.toBeInTheDocument();
  await userEvent.click(button("Next"));
  await expect.element(heading("Highlight what you don't get")).toBeVisible();
  await expect.element(button("Highlight, step 2")).toHaveAttribute("aria-current", "step");
  await expect.element(guide()).toHaveAccessibleDescription(/^Highlight what you don't get /);
  await userEvent.click(button("Back"));
  await expect.element(heading("Welcome to T3 Learn")).toBeVisible();
  await expect.element(button("Next")).toHaveFocus();

  await userEvent.click(button("Next"));
  await userEvent.click(button("Next"));
  await expect.element(heading("Ask your own question")).toBeVisible();
  await userEvent.click(button("Next"));
  await expect.element(heading("Press Done when it clicks")).toBeVisible();
  await userEvent.click(button("Next"));
  await expect.element(heading("See it all on the Map")).toBeVisible();
  await expect
    .element(page.getByText("You can open this guide again from Settings."))
    .toBeVisible();
  await expect.element(button("Skip")).not.toBeInTheDocument();
  expect(storedSeenAt()).toBeNull();

  await userEvent.click(button("Start learning"));
  await expect.element(guide()).not.toBeInTheDocument();
  expect(storedSeenAt()).toBe(JSON.stringify(NOW));
});

it("closes on Skip and records the visit", async () => {
  using _storage = setup();
  await using _screen = await mount();
  using _clock = systemTime(NOW);

  await userEvent.click(button("Skip"));
  await expect.element(guide()).not.toBeInTheDocument();
  expect(storedSeenAt()).toBe(JSON.stringify(NOW));
});

it("opens on request even after it was seen, and keeps the first visit's time", async () => {
  using _storage = setup({ seenAt: EARLIER, lessonSideChats: [false] });
  await using _screen = await mount();
  await expect.element(guide()).not.toBeInTheDocument();

  await act(() => openWelcomeGuide());
  await expect.element(guide()).toBeVisible();
  await userEvent.click(button("Close"));
  await expect.element(guide()).not.toBeInTheDocument();
  expect(storedSeenAt()).toBe(JSON.stringify(EARLIER));
});
