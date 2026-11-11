import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_TERMINAL_ID, TerminalOpenInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getTerminalLabel, nextTerminalId } from "./terminalLabels.ts";

const decodeTerminalOpen = Schema.decodeUnknownSync(TerminalOpenInput);

describe("nextTerminalId", () => {
  it("skips over taken term-N slots", () => {
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, "term-2", "term-3"])).toBe("term-4");
    expect(nextTerminalId([DEFAULT_TERMINAL_ID, "term-3"])).toBe("term-2");
    expect(nextTerminalId(["term-2", "term-3"])).toBe("term-1");
  });

  it("avoids unseen sessions when metadata is unavailable and resumes normal numbering", () => {
    const first = nextTerminalId([], "783c91cc-a413-47c7-8312-c2a5a1f05e40");
    const second = nextTerminalId([first], "102315fc-ceef-45c4-b978-c4d4947d3c26");
    expect(first).not.toBe(DEFAULT_TERMINAL_ID);
    expect(second).not.toBe(first);
    expect(getTerminalLabel(second)).toBe("Terminal 2");
    expect(nextTerminalId([first, second])).toBe("term-3");
    expect(
      decodeTerminalOpen({
        threadId: "thread",
        terminalId: second,
        cwd: "/workspace",
      }),
    ).toMatchObject({ terminalId: second });
  });
});
