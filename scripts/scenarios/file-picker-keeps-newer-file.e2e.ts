/// <reference lib="dom" />
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
      const { promise: requested, resolve: markRequested } = Promise.withResolvers<void>();
      const { promise: released, resolve: release } = Promise.withResolvers<void>();
      const { promise: replied, resolve: markReplied } = Promise.withResolvers<void>();
      Object.assign(window, {
        citationRequested: requested,
        releaseCitation: release,
        citationReplied: replied,
      });

      // Delay only the citation's real search, so the file picker can search in the meantime.
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request =
          typeof data === "string"
            ? (JSON.parse(data) as {
                _tag?: string;
                id?: string;
                tag?: string;
                payload?: { query?: string };
              })
            : null;
        if (
          request?._tag !== "Request" ||
          request.tag !== "projects.searchEntries" ||
          request.payload?.query !== citation
        ) {
          return send.call(this, data);
        }

        const onReply = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;
          const messages = [JSON.parse(event.data)].flat();
          if (
            !messages.some((message) => message._tag === "Exit" && message.requestId === request.id)
          )
            return;
          this.removeEventListener("message", onReply);
          markReplied();
        };
        this.addEventListener("message", onReply);
        markRequested();
        void released.then(() => send.call(this, data));
      };
    }, CITED);

    const activeTab = browser.locator('[data-active-tab="true"]');
    await t3.open(thread);
    await screen.getByRole("button", /^Agent See/).tap();
    await screen.getByRole("link", /^cited-note\.txt/).tap();
    await browser.evaluate(async () => {
      await (window as unknown as { citationRequested: Promise<void> }).citationRequested;
      return null;
    });

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill(PICKED);
    await screen.getByRole("option", PICKED, { exact: false }).tap();
    await activeTab.getByText(PICKED, { exact: true }).waitFor();

    await browser.evaluate(async () => {
      const test = window as unknown as {
        releaseCitation: () => void;
        citationReplied: Promise<void>;
      };
      test.releaseCitation();
      await test.citationReplied;
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
