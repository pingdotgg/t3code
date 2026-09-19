import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import {
  firstStrongDirection,
  markdownBlockDirection,
  nativeMarkdownDocumentRuns,
  resolvedTextDirection,
} from "./nativeMarkdownText";

const HEBREW_MIXED = "שלום, זה טקסט בעברית עם מונח באנגלית כמו Claude Code בתוכו.";

function text(content: string): MarkdownNode {
  return { type: "text", content };
}

function paragraph(...children: MarkdownNode[]): MarkdownNode {
  return { type: "paragraph", children };
}

function document(...children: MarkdownNode[]): MarkdownNode {
  return { type: "document", children };
}

describe("firstStrongDirection", () => {
  it("resolves Hebrew and Arabic text as RTL", () => {
    expect(firstStrongDirection("שלום עולם")).toBe("rtl");
    expect(firstStrongDirection("مرحبا بالعالم")).toBe("rtl");
  });

  it("resolves Latin text as LTR", () => {
    expect(firstStrongDirection("Hello world")).toBe("ltr");
  });

  it("lets the first letter decide when languages mix", () => {
    expect(firstStrongDirection(HEBREW_MIXED)).toBe("rtl");
    expect(firstStrongDirection("Claude Code זה כלי")).toBe("ltr");
  });

  it("skips neutral digits, punctuation and symbols", () => {
    expect(firstStrongDirection('42 - "שלום"')).toBe("rtl");
    expect(firstStrongDirection("3. Hello")).toBe("ltr");
  });

  it("defaults to LTR when no letter exists", () => {
    expect(firstStrongDirection("")).toBe("ltr");
    expect(firstStrongDirection("123 !?")).toBe("ltr");
  });
});

describe("resolvedTextDirection", () => {
  it("reads Hebrew that opens with a URL right-to-left", () => {
    expect(resolvedTextDirection("https://claude.ai זה האתר של קלוד")).toBe("rtl");
  });

  it("reads Hebrew that opens with a file name right-to-left", () => {
    expect(resolvedTextDirection("server.py זה הקובץ הראשי")).toBe("rtl");
  });

  it("reads Hebrew that opens with a path right-to-left", () => {
    expect(resolvedTextDirection("src/main.ts זה הקובץ שצריך לערוך")).toBe("rtl");
  });

  it("reads Hebrew that opens with an inline-code span right-to-left", () => {
    expect(resolvedTextDirection("`git status` תריץ קודם")).toBe("rtl");
  });

  it("keeps English with one Hebrew word left-to-right", () => {
    expect(resolvedTextDirection("The word שלום means hello")).toBe("ltr");
  });

  it("keeps pure English left-to-right", () => {
    expect(resolvedTextDirection("Hello world")).toBe("ltr");
  });

  it("keeps Hebrew-first text right-to-left, unchanged", () => {
    expect(resolvedTextDirection(HEBREW_MIXED)).toBe("rtl");
  });

  it("keeps plain English words before Hebrew left-to-right (no tech token)", () => {
    // Latin letters hold the majority here, so the leading English words decide.
    expect(resolvedTextDirection("Claude Code זה כלי")).toBe("ltr");
  });

  it("reads a Hebrew sentence that opens with a Latin prose label right-to-left", () => {
    expect(
      resolvedTextDirection('Next step (ישן): "מתחילים לבנות תחנה 1, לאט. החוסמים: 3 קבצים."'),
    ).toBe("rtl");
    expect(resolvedTextDirection("TL;DR: הפיצ׳ר עובד, נשאר רק לנקות את הקוד")).toBe("rtl");
    // A Latin-majority sentence quoting some Hebrew still reads left-to-right.
    expect(resolvedTextDirection("The customer wrote שלום וברכה in the ticket")).toBe("ltr");
  });

  it("discounts quoted and parenthesized Latin citations from the vote", () => {
    expect(resolvedTextDirection('PROFILE — הוספתי סעיף "Build-feedback call additions"')).toBe(
      "rtl",
    );
    expect(resolvedTextDirection("P1 — אסטרטגיות (product-lens):")).toBe("rtl");
    // A Hebrew quotation inside English prose keeps its vote — still LTR.
    expect(resolvedTextDirection('They titled it "ברוכים הבאים" and moved on quickly')).toBe("ltr");
  });
});

describe("markdownBlockDirection", () => {
  it("discounts a leading file name in plain paragraph text", () => {
    expect(markdownBlockDirection(paragraph(text("server.py זה הקובץ הראשי")))).toBe("rtl");
  });

  it("discounts a leading URL in plain paragraph text", () => {
    expect(markdownBlockDirection(paragraph(text("https://claude.ai האתר של קלוד")))).toBe("rtl");
  });
  it("reads the block's own text content", () => {
    expect(markdownBlockDirection(paragraph(text("שלום")))).toBe("rtl");
    expect(markdownBlockDirection(paragraph(text("Hello")))).toBe("ltr");
  });

  it("ignores code and tables when resolving the direction", () => {
    expect(
      markdownBlockDirection(
        paragraph({ type: "code_inline", content: "npm install" }, text(" שלום")),
      ),
    ).toBe("rtl");
    expect(
      markdownBlockDirection(
        document({ type: "code_block", content: "שגיאה = 1" }, paragraph(text("Hello"))),
      ),
    ).toBe("ltr");
  });

  it("ignores HTML tag names, but not the text they wrap", () => {
    expect(markdownBlockDirection(paragraph({ type: "html_inline", content: "<u>שלום</u>" }))).toBe(
      "rtl",
    );
  });
});

describe("nativeMarkdownDocumentRuns direction", () => {
  it("marks a Hebrew paragraph RTL and an English one LTR in the same document", () => {
    const runs = nativeMarkdownDocumentRuns(
      document(paragraph(text(HEBREW_MIXED)), paragraph(text("An English paragraph."))),
    );
    const hebrew = runs.find((run) => run.text.includes("שלום"));
    const english = runs.find((run) => run.text.includes("English"));
    expect(hebrew?.writingDirection).toBe("rtl");
    expect(english?.writingDirection).toBe("ltr");
  });

  it("gives every list item its own direction, markers included", () => {
    const runs = nativeMarkdownDocumentRuns(
      document({
        type: "list",
        ordered: false,
        children: [
          { type: "list_item", children: [paragraph(text("פריט ראשון"))] },
          { type: "list_item", children: [paragraph(text("Item in English"))] },
        ],
      }),
    );
    // Mixed lists keep each marker beside the text it labels (web: per-item dir).
    const hebrewItem = runs.find((run) => run.text.includes("פריט"));
    const englishItem = runs.find((run) => run.text.includes("English"));
    expect(hebrewItem?.writingDirection).toBe("rtl");
    expect(englishItem?.writingDirection).toBe("ltr");
    const markers = runs.filter((run) => run.role === "list-marker");
    expect(markers.map((run) => run.writingDirection)).toEqual(["rtl", "ltr"]);
  });

  it("inherits the outer direction into nested lists", () => {
    const runs = nativeMarkdownDocumentRuns(
      document({
        type: "list",
        ordered: false,
        children: [
          {
            type: "list_item",
            children: [
              paragraph(text("רשימה בעברית")),
              {
                type: "list",
                ordered: false,
                children: [{ type: "list_item", children: [paragraph(text("English nested"))] }],
              },
            ],
          },
        ],
      }),
    );
    for (const run of runs) {
      expect(run.writingDirection).toBe("rtl");
    }
  });

  it("isolates Latin runs inside RTL text so surrounding punctuation stays put", () => {
    const runs = nativeMarkdownDocumentRuns(
      document(paragraph(text('הבוט "סותר את Kapso" וגם U1+U2+U3+U5, ההסלמה'))),
    );
    const body = runs.find((run) => run.text.includes("Kapso"));
    expect(body?.text).toContain("⁦Kapso⁩");
    expect(body?.text).toContain("⁦U1+U2+U3+U5⁩");
    // The closing quote and the comma stay outside the isolates.
    expect(body?.text).toContain('⁦Kapso⁩"');
    expect(body?.text).toContain("⁩, ההסלמה");
  });

  it("leaves LTR text without isolates", () => {
    const runs = nativeMarkdownDocumentRuns(document(paragraph(text("Plain English text here"))));
    expect(runs[0]?.text).not.toContain("⁦");
  });

  it("marks a Hebrew heading RTL", () => {
    const runs = nativeMarkdownDocumentRuns(
      document({ type: "heading", level: 2, children: [text("כותרת בעברית")] }),
    );
    expect(runs[0]?.writingDirection).toBe("rtl");
  });

  it("pins code blocks LTR even when their content is Hebrew", () => {
    const runs = nativeMarkdownDocumentRuns(
      document(paragraph(text("הסבר בעברית")), {
        type: "code_block",
        language: "js",
        content: '// הערה בעברית\nconst x = "שלום";\n',
      }),
    );
    for (const run of runs.filter(
      (item) => item.role === "code-block" || item.role === "code-language",
    )) {
      expect(run.writingDirection).toBe("ltr");
    }
  });

  it("keeps a blockquote one directional unit", () => {
    const runs = nativeMarkdownDocumentRuns(
      document({
        type: "blockquote",
        children: [paragraph(text("ציטוט בעברית")), paragraph(text("English continuation"))],
      }),
    );
    for (const run of runs) {
      expect(run.writingDirection).toBe("rtl");
    }
  });

  it("wraps inline code inside an RTL paragraph in an LTR isolate", () => {
    const runs = nativeMarkdownDocumentRuns(
      document(
        paragraph(text("תריץ "), { type: "code_inline", content: "git status" }, text(" עכשיו")),
      ),
    );
    const code = runs.find((run) => run.code);
    expect(code?.text).toBe("\u2066git status\u2069");
    expect(code?.writingDirection).toBe("rtl");
  });

  it("leaves inline code inside an LTR paragraph untouched", () => {
    const runs = nativeMarkdownDocumentRuns(
      document(paragraph(text("Run "), { type: "code_inline", content: "git status" })),
    );
    const code = runs.find((run) => run.code);
    expect(code?.text).toBe("git status");
  });

  it("honors an explicitly inherited direction", () => {
    const runs = nativeMarkdownDocumentRuns(document(paragraph(text("English text"))), [], "rtl");
    expect(runs[0]?.writingDirection).toBe("rtl");
  });
});
