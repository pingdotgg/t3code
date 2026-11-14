/// <reference lib="dom" />
// The DOM lib types the functions this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { runPromise, test, WEB } from "./t3.ts";

const chmod = (path: string, mode: number) =>
  runPromise(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.chmod(path, mode)));

test(
  "A saved file shows a later external edit after its post-save read failed",
  WEB,
  async ({ t3, app, browser, screen }) => {
    // Logs each file RPC's outcome in order, so the test can wait for the read after the save.
    await browser.addInitScript(() => {
      const log: Array<string> = [];
      const tags = new Map<string, string>();
      const watched = new WeakSet<WebSocket>();
      Object.assign(window, { fileRpcLog: log });
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          for (const message of [JSON.parse(data)].flat()) {
            if (message?._tag === "Request") tags.set(String(message.id), message.tag);
          }
        }
        if (!watched.has(this)) {
          watched.add(this);
          this.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            for (const message of [JSON.parse(event.data)].flat()) {
              const tag = message?._tag === "Exit" ? tags.get(String(message.requestId)) : null;
              if (tag?.startsWith("projects.")) log.push(`${tag}:${message.exit._tag}`);
            }
          });
        }
        return send.call(this, data);
      };
    });
    const loggedAfter = (after: string, entry: string) =>
      browser.evaluate(
        ({ after, entry }) => {
          const log = (window as unknown as { fileRpcLog: Array<string> }).fileRpcLog;
          const start = log.lastIndexOf(after);
          return start >= 0 && log.indexOf(entry, start + 1) > start;
        },
        { after, entry },
      );
    // The file tree and editor render in shadow roots that locators do not reach.
    const openTreeRow = (path: string) =>
      browser.evaluate((path) => {
        for (const host of document.querySelectorAll("*")) {
          const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
          if (row) {
            row.click();
            return true;
          }
        }
        return false;
      }, path);
    const editorText = () =>
      browser.evaluate(() => {
        for (const host of document.querySelectorAll("*")) {
          const content = host.shadowRoot?.querySelector("[data-content]");
          if (content) return content.textContent ?? "";
        }
        return null;
      });

    const project = await t3.project("demo", { "notes.txt": "before save" });
    const notes = `${project}/notes.txt`;
    const thread = await t3.thread({ project, title: "Notes", messages: ["first"] });
    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
    await screen.getByRole("button", "Toggle right panel").tap();
    await screen.getByText("Files").tap();
    await expect.poll(() => openTreeRow("notes.txt")).toBe(true);
    await expect.poll(editorText).toContain("before save");

    // Requires a non-root server and in-place writes: autosave succeeds, confirmation read fails.
    await chmod(notes, 0o200);
    await browser.keyboard.press("ControlOrMeta+a");
    await browser.keyboard.type("saved draft");
    await expect
      .poll(() => loggedAfter("projects.writeFile:Success", "projects.readFile:Failure"))
      .toBe(true);

    await chmod(notes, 0o644);
    await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(notes, "external update")),
    );
    await screen.getByRole("button", "Refresh workspace files").tap();
    await expect
      .poll(() => loggedAfter("projects.readFile:Failure", "projects.readFile:Success"))
      .toBe(true);
    await app.screenshot("after-external-edit");
    await expect.poll(editorText).toContain("external update");
  },
);
