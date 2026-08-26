import { describe, expect, it } from "vite-plus/test";

import {
  appendReportContextToPrompt,
  buildReportContextBlock,
  extractTrailingReportContext,
} from "./reportContext";

const context = { title: "Say which limit was hit", markdown: "# Report\n\nBody." };

describe("report context", () => {
  it("puts the person's words first and the report after them", () => {
    const prompt = appendReportContextToPrompt("Fix this properly", context);
    expect(prompt.startsWith("Fix this properly")).toBe(true);
    expect(prompt).toContain('<report_context title="Say which limit was hit">');
  });

  it("round-trips back out of the message", () => {
    const prompt = appendReportContextToPrompt("Fix this properly", context);
    const extracted = extractTrailingReportContext(prompt);
    expect(extracted.promptText).toBe("Fix this properly");
    expect(extracted.context?.title).toBe("Say which limit was hit");
    expect(extracted.context?.markdown).toBe("# Report\n\nBody.");
  });

  it("carries a report with no message of its own", () => {
    const extracted = extractTrailingReportContext(appendReportContextToPrompt("", context));
    expect(extracted.promptText).toBe("");
    expect(extracted.context?.markdown).toBe("# Report\n\nBody.");
  });

  it("leaves an ordinary message alone", () => {
    const extracted = extractTrailingReportContext("just a message");
    expect(extracted.promptText).toBe("just a message");
    expect(extracted.context).toBeNull();
  });

  it("keeps a quote in the title from breaking the attribute", () => {
    const block = buildReportContextBlock({ title: 'the "thing"', markdown: "body" });
    expect(block).toContain(`title="the 'thing'"`);
    expect(extractTrailingReportContext(block).context?.title).toBe("the 'thing'");
  });

  it("emits nothing for an empty report", () => {
    expect(buildReportContextBlock({ title: "x", markdown: "  \n " })).toBe("");
    expect(appendReportContextToPrompt("hi", { title: "x", markdown: "" })).toBe("hi");
  });
});
