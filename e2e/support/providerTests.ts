// @effect-diagnostics nodeBuiltinImport:off - reads the test's repository, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect } from "e2e";

import { WAITING_TEXT, WRITTEN_CONTENT } from "../fixtures/scenario.ts";
import { describe, test } from "./test.ts";

/** How a provider differs in the UI; everything else is the shared flow below. */
export interface ProviderUnderTest {
  /** The provider's name in the model picker and in its fake's replies. */
  readonly name: string;
  /** Signs in from Settings → Providers first, as Antigravity needs before it lists models. */
  readonly signIn?: boolean;
  /** The approval button, when the provider names its own permission options. */
  readonly approve?: string;
}

/**
 * Registers the same reply, approval, and Stop flows for one provider adapter, backed by
 * its scripted fake CLI under e2e/fixtures. Each provider gets its own test file so the
 * runner schedules them on separate workers. Cursor has none: its SDK runs in the server
 * process and talks to Cursor's backend directly, so there is no process to stand in for.
 */
export function describeProvider(provider: ProviderUnderTest) {
  describe(`${provider.name} provider`, { tags: ["providers"] }, () => {
    test("streams a reply", async ({ t3, screen }) => {
      if (provider.signIn) await t3.signInProvider(provider.name);
      await t3.startDraft();
      await t3.chooseModel(provider.name);
      await t3.send(`Hello ${provider.name}`);
      await expect(
        screen.getByText(`Fake ${provider.name} received: Hello ${provider.name}`),
      ).toBeVisible();
      await t3.waitForIdle();
    });

    test("asks before running a command and runs it once approved", async ({ t3, screen }) => {
      if (provider.signIn) await t3.signInProvider(provider.name);
      const project = await t3.addProject(`${provider.name.toLowerCase()}-approval`);
      await t3.startDraft(project);
      await t3.chooseModel(provider.name);
      await t3.chooseRuntimeMode(/^Supervised/);
      await t3.send("write notes.md");

      await screen.getByRole("button", provider.approve ?? "Approve").tap();
      await expect(screen.getByText("Wrote notes.md.")).toBeVisible();
      expect(NodeFS.readFileSync(NodePath.join(project.root, "notes.md"), "utf8")).toBe(
        WRITTEN_CONTENT,
      );
    });

    test("stops a running turn and keeps the thread usable", async ({ t3, screen }) => {
      if (provider.signIn) await t3.signInProvider(provider.name);
      await t3.startDraft();
      await t3.chooseModel(provider.name);
      await t3.send("wait until I stop you");
      await expect(screen.getByText(WAITING_TEXT)).toBeVisible();
      await screen.getByRole("button", "Stop generation").tap();
      await t3.waitForIdle();

      await t3.send("Still there?");
      await expect(screen.getByText(`Fake ${provider.name} received: Still there?`)).toBeVisible();
    });
  });
}
