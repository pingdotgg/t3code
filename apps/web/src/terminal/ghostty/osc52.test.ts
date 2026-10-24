import { describe, expect, it } from "vite-plus/test";

import { MAX_OSC52_PAYLOAD_LENGTH, Osc52Scanner } from "./osc52";

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function scan(chunks: Iterable<string>): string[] {
  const copies: string[] = [];
  const scanner = new Osc52Scanner((text) => copies.push(text));
  for (const chunk of chunks) scanner.write(chunk);
  return copies;
}

describe("Osc52Scanner", () => {
  it("copies writes terminated by BEL or ST, however the output is chunked", () => {
    const stream = [
      "prompt$ ",
      `\x1b]52;c;${base64("héllo 👋")}\x07`,
      "\x1b]0;window title\x07",
      "\x1b]52;c;?\x07",
      `\x1b]52;;${base64("from tmux")}\x1b\\`,
      "done\r\n",
    ].join("");

    expect(scan([stream])).toEqual(["héllo 👋", "from tmux"]);
    expect(scan(stream)).toEqual(["héllo 👋", "from tmux"]);
  });

  it("drops a write longer than the payload limit and keeps scanning", () => {
    const oversized = `\x1b]52;c;${"A".repeat(MAX_OSC52_PAYLOAD_LENGTH)}\x07`;

    expect(
      scan([oversized.slice(0, 4096), oversized.slice(4096), `\x1b]52;c;${base64("next")}\x07`]),
    ).toEqual(["next"]);
  });
});
