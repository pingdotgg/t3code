// @effect-diagnostics nodeBuiltinImport:off - runs inside e2e tests, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { App, Screen } from "e2e";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";

import { FIXTURE_PROJECT_NAME, instancePathsForBaseUrl, isolatedEnv } from "./instance.ts";
import { runT3Cli } from "./pairing.ts";
import { writeFixtureRepository } from "./repository.ts";

/** A T3 project backed by a git repository on disk. */
export interface Project {
  readonly title: string;
  readonly root: string;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Drives one paired browser against the isolated server: the flows every test repeats,
 * named the way the UI names them.
 */
export function createT3(app: App, browser: Browser, screen: Screen) {
  const paths = instancePathsForBaseUrl(app.baseUrl);
  const defaultProject: Project = { title: FIXTURE_PROJECT_NAME, root: paths.project };
  const composer = screen.getByRole("textbox", "Message");

  const t3 = {
    defaultProject,

    /** The sidebar row of the thread titled `title`, whatever status it shows. */
    sidebarRow(title: string, project: Project = defaultProject) {
      return screen.getByRole(
        "button",
        new RegExp(`^${escapeRegExp(title)}, (.+, )?${escapeRegExp(project.title)}$`),
      );
    },

    /** Opens `path` and waits until the composer is interactive. */
    async open(path = "/") {
      await app.open(path);
      await expect(composer).toBeVisible();
    },

    /** Presses a `mod+` keybinding: Meta on macOS, Control elsewhere. */
    async pressShortcut(key: string) {
      const mac = await browser.evaluate(() => /Mac/.test(navigator.platform));
      await browser.keyboard.press(`${mac ? "Meta" : "Control"}+${key}`);
    },

    /**
     * Adds a fresh git repository as its own project, so a test that edits files or
     * commits never sees another test's changes. Each run has its own server, so `name`
     * is used as is; a retried attempt that finds its folder taken gets a numbered title.
     */
    async addProject(name: string): Promise<Project> {
      let title = name;
      for (let attempt = 2; NodeFS.existsSync(NodePath.join(paths.workspaces, title)); attempt++) {
        title = `${name}-${attempt}`;
      }
      const root = NodePath.join(paths.workspaces, title);
      writeFixtureRepository(root, title, isolatedEnv(paths));
      await runT3Cli(app.baseUrl, ["project", "add", root, "--title", title]);
      return { title, root };
    },

    /** Opens a fresh draft in `project` through the command palette's project picker. */
    async startDraft(project: Project = defaultProject) {
      await t3.open();
      await t3.pressShortcut("k");
      const palette = screen.getByRole("dialog", "Command palette");
      await palette.getByRole("option", /^New thread in\.\.\./).tap();
      await palette.getByRole("option", new RegExp(`^${escapeRegExp(project.title)} Local`)).tap();
      await expect(browser).toHaveURL(/\/draft\//);
      await expect(
        screen.getByRole("heading", `What should we build in ${project.title}?`),
      ).toBeVisible();
    },

    /** Types `text` into the composer and submits it. */
    async send(text: string) {
      await composer.fill(text);
      await expect(composer).toHaveText(text);
      await screen.getByRole("button", "Submit message").tap();
    },

    /** Waits until the thread's run has finished, including the work after its last reply. */
    async waitForIdle() {
      await expect(screen.getByRole("button", "Stop generation")).not.toBeVisible();
    },

    /** Starts a thread with `prompt` and waits for the fake Codex reply and an idle run. */
    async startThread(prompt: string, project: Project = defaultProject) {
      await t3.startDraft(project);
      await t3.send(prompt);
      await expect(screen.getByText(`Fake Codex received: ${prompt}`)).toBeVisible();
      await expect(screen.getByRole("heading", prompt)).toBeVisible();
      await t3.waitForIdle();
    },

    /**
     * Selects `provider`'s first model in the composer's model picker, opened with its
     * `mod+shift+m` keybinding since the trigger is labelled by whichever model is current.
     */
    async chooseModel(provider: string) {
      const providers = screen.getByRole("toolbar", "Providers");
      // A keypress right after a draft mounts can land before the keybinding is registered,
      // so press until the picker shows; checking first keeps the toggle from closing it.
      await expect
        .poll(
          async () => {
            if ((await providers.count()) > 0) return true;
            await t3.pressShortcut("Shift+m");
            return false;
          },
          { interval: 500 },
        )
        .toBe(true);
      const picker = screen.getByRole("dialog");
      await providers.getByRole("button", new RegExp(`^${escapeRegExp(provider)}\\b`)).tap();
      await picker.getByRole("option").first().tap();
      await expect(picker).not.toBeVisible();
    },

    /**
     * Signs a provider in from Settings → Providers when it offers "Sign in", as
     * Antigravity does before its first session. A no-op once it is authenticated.
     */
    async signInProvider(provider: string) {
      await app.open("/settings/providers");
      await screen.getByRole("button", `Select ${provider}`).tap();
      const signIn = screen.getByRole("button", "Sign in");
      if ((await signIn.count()) > 0) await signIn.tap();
      await expect(screen.getByText(/^Authenticated/).first()).toBeVisible();
    },

    /** Picks a runtime mode, such as `/^Supervised/`, from the composer. */
    async chooseRuntimeMode(mode: RegExp) {
      await screen.getByRole("combobox", "Runtime mode").tap();
      await screen.getByRole("option", mode).tap();
    },

    /** Opens the breadcrumb's thread actions menu and picks `action`. */
    async threadAction(title: string, action: string) {
      await screen.getByRole("button", `Thread actions for ${title}`).tap();
      await screen.getByText(action).last().tap();
    },
  };
  return t3;
}

export type T3 = ReturnType<typeof createT3>;
