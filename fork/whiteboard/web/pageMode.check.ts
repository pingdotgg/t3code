// Hand-written input/output pairs for pageMode, decided before running; run with `npm test`.
import * as NodeAssert from "node:assert/strict";
import { hostHeaderName, pageMode, type OpenView, type PageMode } from "./pageMode";

const openViews: Record<string, OpenView> = {
  "board.example.com": "board",
  "chat.example.com": "chat",
  "app.example.com": "app",
};

const modePairs: Array<[hostname: string, search: string, framed: boolean, PageMode]> = [
  // Export wins over everything, framed or not, on any hostname.
  ["app.example.com", "?export=0,0,10,10", false, { kind: "export" }],
  ["app.example.com", "?export&embed=panel", true, { kind: "export" }],
  ["localhost", "?export", false, { kind: "export" }],
  // The board-only embed needs both the parameter and a parent window.
  ["app.example.com", "?embed=panel&room=%2Fsrv%2Fcode", true, { kind: "embed" }],
  ["localhost", "?embed=panel", true, { kind: "embed" }],
  ["app.example.com", "?embed=panel&room=x", false, { kind: "split", start: "board" }],
  ["localhost", "?embed=panel", false, { kind: "split", start: "remembered" }],
  ["localhost", "?embed", true, { kind: "split", start: "remembered" }],
  ["localhost", "?embed=other", true, { kind: "split", start: "remembered" }],
  // An "app" hostname sends bare / to the chat; any query shows the board.
  ["app.example.com", "", false, { kind: "redirect", to: "/chat/" }],
  ["app.example.com", "?", false, { kind: "redirect", to: "/chat/" }],
  ["app.example.com", "", true, { kind: "redirect", to: "/chat/" }],
  ["app.example.com", "?room=srv-code", false, { kind: "split", start: "board" }],
  ["app.example.com", "?view=fit", false, { kind: "split", start: "board" }],
  // The other openViews keep their start view; unlisted hostnames reopen the remembered layout.
  ["board.example.com", "", false, { kind: "split", start: "board" }],
  ["board.example.com", "?room=x", false, { kind: "split", start: "board" }],
  ["chat.example.com", "", false, { kind: "split", start: "chat" }],
  ["localhost", "", false, { kind: "split", start: "remembered" }],
  ["toString", "", false, { kind: "split", start: "remembered" }],
];

let checked = 0;
for (const [hostname, search, framed, expected] of modePairs) {
  NodeAssert.deepEqual(
    pageMode({ hostname, search, framed, openViews }),
    expected,
    `pageMode(${hostname}, ${JSON.stringify(search)}, framed=${framed})`,
  );
  checked++;
}

const hostPairs: Array<[string, string]> = [
  ["app.example.com", "app.example.com"],
  ["app.example.com:6061", "app.example.com"],
  ["App.Example.COM:443", "app.example.com"],
  ["127.0.0.1:6061", "127.0.0.1"],
  ["[::1]:6061", "[::1]"],
  ["[::1]", "[::1]"],
];
for (const [header, expected] of hostPairs) {
  NodeAssert.equal(hostHeaderName(header), expected, `hostHeaderName(${header})`);
  checked++;
}

console.log(`pageMode: ${checked} checks pass`);
