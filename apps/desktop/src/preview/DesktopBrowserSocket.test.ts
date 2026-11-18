import { expect, it } from "vite-plus/test";

import { translateWslPaths } from "./DesktopBrowserSocket.ts";

const key = { threadId: "thread-1", tabId: "tab-1" };
const cdp = (message: object) =>
  JSON.stringify({ type: "cdp", ...key, message: JSON.stringify(message) });
const translated = (message: object) =>
  JSON.parse(JSON.parse(translateWslPaths(cdp(message), "Ubuntu")).message).params;

it("translates the paths a WSL server sends to the Windows page, and nothing else", () => {
  expect(
    translated({
      id: 1,
      method: "DOM.setFileInputFiles",
      params: {
        objectId: "1",
        files: ["/home/alice/project/report.csv", "/mnt/c/Users/alice/a b.txt"],
      },
    }),
  ).toEqual({
    objectId: "1",
    files: [
      "\\\\wsl.localhost\\Ubuntu\\home\\alice\\project\\report.csv",
      "C:\\Users\\alice\\a b.txt",
    ],
  });
  expect(
    translated({
      id: 2,
      method: "Browser.setDownloadBehavior",
      params: {
        behavior: "allowAndName",
        downloadPath: "/tmp/playwright-artifacts-1",
        eventsEnabled: true,
      },
    }),
  ).toEqual({
    behavior: "allowAndName",
    downloadPath: "\\\\wsl.localhost\\Ubuntu\\tmp\\playwright-artifacts-1",
    eventsEnabled: true,
  });

  // A page may type either method's name; only the command itself is rewritten.
  const typed = cdp({
    id: 3,
    method: "Input.insertText",
    params: { text: "DOM.setFileInputFiles /home" },
  });
  expect(translateWslPaths(typed, "Ubuntu")).toBe(typed);
  const pointer = JSON.stringify({ type: "pointer", ...key, phase: "move", x: 1, y: 2 });
  expect(translateWslPaths(pointer, "Ubuntu")).toBe(pointer);
});
