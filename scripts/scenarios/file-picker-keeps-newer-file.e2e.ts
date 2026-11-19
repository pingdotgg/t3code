/// <reference lib="dom" />
import type { EnvironmentId, ProjectSearchEntriesInput } from "@t3tools/contracts";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

const CITED = "cited-note.txt";
const PICKED = "picker-note.txt";

test(
  "A slow citation leaves the newer file picker choice active",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo", {
      [`notes/${CITED}`]: "Text from the earlier citation",
      [PICKED]: "Text from the newer choice",
    });
    const thread = await t3.thread({
      project,
      title: "File preview order",
      messages: [`See :codex-file-citation{path="${CITED}" line_range_start="1"}`],
    });

    await browser.addInitScript((citation) => {
      const { promise: requested, resolve: markRequested } =
        Promise.withResolvers<ProjectSearchEntriesInput>();
      const { promise: released, resolve: release } = Promise.withResolvers<void>();
      Object.assign(window, {
        citationRequested: requested,
        releaseCitation: release,
      });

      // Delay only the citation's real search, so the file picker can search in the meantime.
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request =
          typeof data === "string"
            ? (JSON.parse(data) as {
                _tag?: string;
                tag?: string;
                payload?: ProjectSearchEntriesInput;
              })
            : null;
        if (
          request?._tag !== "Request" ||
          request.tag !== "projects.searchEntries" ||
          request.payload?.query !== citation
        ) {
          return send.call(this, data);
        }

        markRequested(request.payload);
        void released.then(() => send.call(this, data));
      };
    }, CITED);

    const activeTab = browser.locator('[data-active-tab="true"]');
    await t3.open(thread);
    await screen.getByRole("button", /^Agent See/).tap();
    await screen.getByRole("link", /^cited-note\.txt/).tap();
    await browser.evaluate(async () => {
      await (window as unknown as { citationRequested: Promise<ProjectSearchEntriesInput> })
        .citationRequested;
      return null;
    });

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill(PICKED);
    await screen.getByRole("option", PICKED, { exact: false }).tap();
    await activeTab.getByText(PICKED, { exact: true }).waitFor();

    await browser.evaluate(async () => {
      const test = window as unknown as {
        releaseCitation: () => void;
        citationRequested: Promise<ProjectSearchEntriesInput>;
      };
      const registryModule = "/src/rpc/atomRegistry.ts";
      const projectsModule = "/src/state/projects.ts";
      const reactModule = performance
        .getEntriesByType("resource")
        .find(({ name }) => /\/\.vite\/deps\/react\.js(?:\?|$)/.test(name))?.name;
      if (!reactModule) throw new Error("The app's React module has not loaded");
      const [{ appAtomRegistry }, { projectEnvironment }, { default: react }] = await Promise.all([
        import(registryModule) as Promise<typeof import("../../apps/web/src/rpc/atomRegistry.ts")>,
        import(projectsModule) as Promise<typeof import("../../apps/web/src/state/projects.ts")>,
        import(reactModule) as Promise<{
          default: { act: (run: () => Promise<void>) => PromiseLike<void> };
        }>,
      ]);
      const atom = projectEnvironment.searchEntries({
        environmentId: location.pathname.split("/")[1] as EnvironmentId,
        input: await test.citationRequested,
      });
      // Wait for the query used by the citation and flush React before reading the selected tab.
      await react.act(async () => {
        const { promise, resolve } = Promise.withResolvers<void>();
        const unsubscribe = appAtomRegistry.subscribe(atom, (result) => {
          if (result._tag !== "Initial" && !result.waiting) resolve();
        });
        try {
          test.releaseCitation();
          await promise;
        } finally {
          unsubscribe();
        }
      });
      return null;
    });
    await app.screenshot("active-file-after-citation-search");
    const activeFile = await browser.evaluate(
      () =>
        document.querySelector('[data-active-tab="true"] button:last-of-type')?.textContent ?? null,
    );
    expect(activeFile).toBe(PICKED);
  },
);
