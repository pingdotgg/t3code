import { describe, expect, it } from "vite-plus/test";

import { designPathFromUrl, expandDesignCommand, visibleDesignCommand } from "./designPrompt.ts";

describe("expandDesignCommand", () => {
  it("turns a design command into a thread-scoped visual design brief", () => {
    const result = expandDesignCommand({
      prompt: "/design a billing dashboard",
      threadId: "thread-42",
    });

    expect(result.startsWith("<t3_design_request>")).toBe(true);
    expect(result).toContain(".t3/designs/thread-42.html");
    expect(visibleDesignCommand(result)).toBe("/design a billing dashboard");
    expect(visibleDesignCommand(`${result}\n\n<terminal_context>hidden</terminal_context>`)).toBe(
      "/design a billing dashboard\n\n<terminal_context>hidden</terminal_context>",
    );
    expect(visibleDesignCommand(`Ultrathink:\n${result}`)).toBe(
      "Ultrathink:\n/design a billing dashboard",
    );
  });

  it("preserves internal marker text from the user and later context", () => {
    const prompt = "/design show </t3_design_request> as text";
    const result = expandDesignCommand({ prompt, threadId: "thread-42" });
    const context = "\n\n<terminal_context>also\n\n</t3_design_request></terminal_context>";

    expect(visibleDesignCommand(`${result}${context}`)).toBe(`${prompt}${context}`);
  });

  it("leaves ordinary prompts unchanged", () => {
    expect(
      expandDesignCommand({ prompt: "Fix the billing dashboard", threadId: "thread-42" }),
    ).toBe("Fix the billing dashboard");
  });

  it("does not claim an empty design command", () => {
    expect(expandDesignCommand({ prompt: "/design", threadId: "thread-42" })).toBe("/design");
  });

  it("accepts command casing", () => {
    expect(
      expandDesignCommand({ prompt: "/Design a billing dashboard", threadId: "thread-42" }),
    ).toMatch(/^<t3_design_request>/);
  });

  it("reads design context only from marked asset URLs", () => {
    expect(
      designPathFromUrl(
        "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=.t3%2Fdesigns%2Fthread-1.html",
        "http://127.0.0.1:3773",
      ),
    ).toBe(".t3/designs/thread-1.html");
    expect(
      designPathFromUrl(
        "https://example.com/api/assets/token?t3-design=request-1&t3-design-path=.t3%2Fdesigns%2Fthread-1.html",
        "http://127.0.0.1:3773",
      ),
    ).toBeNull();
    expect(
      designPathFromUrl(
        "http://127.0.0.1:3773/api/assets/token?t3-design=request-1&t3-design-path=index.html",
        "http://127.0.0.1:3773",
      ),
    ).toBeNull();
  });

  it("leaves ordinary message display unchanged", () => {
    expect(visibleDesignCommand("Fix the billing dashboard")).toBe("Fix the billing dashboard");
  });
});
