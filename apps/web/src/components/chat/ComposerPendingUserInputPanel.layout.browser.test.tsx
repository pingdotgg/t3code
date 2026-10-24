import "../../index.css";

import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text, className }: { text: string; className?: string }) => (
    <p className={className}>{text}</p>
  )) as never,
}));

import { act, render } from "../../../test/render";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

async function renderPanel(
  {
    header,
    question = "Pick one.",
    questionCount = 1,
    multiSelect = false,
    width = 320,
    options = [{ label: "Rolling", description: "One node at a time" }],
    queue,
  }: {
    header: string;
    question?: string;
    questionCount?: number;
    multiSelect?: boolean;
    width?: number;
    options?: { label: string; description: string; customAnswer?: boolean }[];
    queue?: { index: number; total: number };
  },
  run: (
    container: HTMLDivElement,
    rerender: (answers: Record<string, PendingUserInputDraftAnswer>) => Promise<void>,
  ) => Promise<void>,
) {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  const panel = (answers: Record<string, PendingUserInputDraftAnswer>) => (
    <ComposerBanner.Root>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId: RuntimeRequestId.make("long-header"),
            createdAt: "2026-10-20T00:00:00.000Z",
            dismissible: true,
            responseCapability: "live",
            ...(queue ? { queueQuestionIndex: queue.index, queueQuestionTotal: queue.total } : {}),
            questions: Array.from({ length: questionCount }, (_, index) => ({
              id: index === 0 ? "strategy" : `strategy-${index}`,
              header,
              question,
              options,
              multiSelect,
            })),
          },
        ]}
        cwd="/repo"
        threadRef={threadRef}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
        onDismiss={() => {}}
      />
    </ComposerBanner.Root>
  );
  // router: false because the pending-input panel never navigates.
  await using screen = await render(panel({}), { container, router: false });
  await run(container, (answers) => screen.rerender(panel(answers)));
}

const centerX = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return rect.left + rect.width / 2;
};

function firstOption(container: HTMLElement) {
  const row = container.querySelector<HTMLElement>("button[aria-pressed]")!;
  const [label, description] = row.querySelectorAll("span");
  const key = row.querySelector("[data-pending-user-input-option-key]")!;
  return { row, label: label!, description: description!, key };
}

it("keeps a long question header inside the collapsed trigger row", async () => {
  const header = "Which of these deployment strategies should the extension use? ".repeat(4);
  await renderPanel({ header }, async (container) => {
    const trigger = container.querySelector<HTMLElement>("[data-pending-user-input-toggle]")!;
    await act(async () => trigger.click());
    const headerElement = [...trigger.querySelectorAll("span")].find(
      (element) => element.textContent === header,
    )!;
    expect(headerElement.getBoundingClientRect().right).toBeLessThanOrEqual(
      trigger.getBoundingClientRect().right,
    );
    expect(trigger.scrollWidth).toBeLessThanOrEqual(trigger.clientWidth);
  });
});

it("selects an option by swapping its number for a check without resizing the row", async () => {
  await renderPanel({ header: "Strategy" }, async (container, rerender) => {
    const measure = () => {
      const { row, key } = firstOption(container);
      return {
        row: row.getBoundingClientRect().toJSON(),
        key: key.getBoundingClientRect().toJSON(),
      };
    };
    const key = () => container.querySelector("[data-pending-user-input-option-key]")!;
    const unselected = measure();
    expect(key().textContent).toBe("1");
    await rerender({ strategy: { selectedOptionValues: ["Rolling"] } });
    expect(container.querySelector("button[aria-pressed]")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(key().querySelector("svg")).not.toBeNull();
    expect(measure()).toEqual(unselected);
  });
});

it.each([
  ["mobile", 414],
  ["sm", 1024],
])(
  "aligns the header band, question, labels and indicators inside the banner surface at %s width",
  async (_, width) => {
    await page.viewport(width, 900);
    const longQuestion = "Explain which rollout you prefer and why it fits this service. ".repeat(
      40,
    );
    for (const header of ["Strategy", "Question"]) {
      for (const question of ["Pick one.", longQuestion]) {
        await renderPanel({ header, question }, async (container) => {
          const viewport = container.querySelector("[data-slot=scroll-area-viewport]")!;
          const overflowing = question === longQuestion;
          if (overflowing) {
            await vi.waitFor(() => expect(viewport.hasAttribute("data-has-overflow-y")).toBe(true));
          } else {
            expect(viewport.hasAttribute("data-has-overflow-y")).toBe(false);
          }
          const surface = container.querySelector("[data-slot=composer-banner]")!;
          const bounds = surface.getBoundingClientRect();
          const gaps = (element: Element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left - bounds.left, right: bounds.right - rect.right };
          };
          const paragraphs = [...container.querySelectorAll("p")];
          const eyebrow = header === "Strategy" ? paragraphs[0] : undefined;
          const questionParagraph = paragraphs.at(-1)!;
          const { row, label, key } = firstOption(container);
          for (const text of [eyebrow, questionParagraph, label]) {
            if (text) expect(gaps(text).left).toBeCloseTo(16, 0);
          }
          // The row fill hangs out past the text column on both sides, into the scrollbar gutter when overflowing.
          expect(gaps(row)).toEqual({ left: 4, right: 4 });
          // Indicators share the trailing action's axis, 22px in from the surface.
          const trailing = [
            ...container.querySelectorAll("[data-slot=composer-banner-actions] svg"),
          ].at(-1)!;
          expect(bounds.right - centerX(trailing)).toBeCloseTo(22, 0);
          expect(centerX(key)).toBeCloseTo(centerX(trailing), 0);
          // The header band runs under the actions to the surface's sides and top, ending 10px below the question.
          const band = container
            .querySelector("[data-pending-user-input-header-band]")!
            .getBoundingClientRect();
          const questionRect = questionParagraph.getBoundingClientRect();
          expect(band.left).toBeCloseTo(bounds.left, 0);
          expect(band.right).toBeCloseTo(bounds.right, 0);
          expect(band.top).toBeCloseTo(bounds.top, 0);
          expect(band.bottom - questionRect.bottom).toBeCloseTo(10, 0);
          // The 12px eyebrow sits 6px above the question; the first row's fill 6px below the band.
          if (eyebrow) {
            expect(questionRect.top - eyebrow.getBoundingClientRect().bottom).toBeCloseTo(6, 0);
          }
          expect(row.getBoundingClientRect().top - band.bottom).toBeCloseTo(6, 0);
          expect(row.getBoundingClientRect().top - questionRect.bottom).toBeCloseTo(16, 0);
          // The last row's fill ends the body's 4px inset above the banner's own padding.
          const body = row.parentElement!.parentElement!;
          expect(body.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom).toBe(4);
        });
      }
    }
  },
);

it.each([
  ["generic", "Question", false, ["Pick one."], "Pick one."],
  ["distinct", "Strategy", false, ["Strategy", "Pick one."], "StrategyPick one."],
  ["distinct multi-select", "Strategy", true, ["Strategy · Select any", "Pick one."], null],
])(
  "leads with the question under a %s header and summarizes it when collapsed",
  async (_, header, multiSelect, expandedLines, collapsedText) => {
    await renderPanel({ header, multiSelect }, async (container) => {
      const trigger = container.querySelector<HTMLElement>("[data-pending-user-input-toggle]")!;
      const paragraphs = () => [...container.querySelectorAll("p")];
      expect(trigger.dataset.pendingUserInputToggle).toBe("expanded");
      expect(trigger.textContent).toBe("");
      expect(trigger.getAttribute("aria-label")).toBe("Hide the question and its options");
      expect(paragraphs().map((paragraph) => paragraph.textContent)).toEqual(expandedLines);
      // The question is always the primary 14px medium line; an eyebrow is a muted 12px label.
      const questionStyle = getComputedStyle(paragraphs().at(-1)!);
      expect(questionStyle.fontSize).toBe("14px");
      expect(questionStyle.fontWeight).toBe("500");
      if (expandedLines.length > 1) {
        const eyebrowStyle = getComputedStyle(paragraphs()[0]!);
        expect(eyebrowStyle.fontSize).toBe("12px");
        expect(eyebrowStyle.fontWeight).toBe("500");
        expect(eyebrowStyle.textTransform).toBe("none");
        expect(eyebrowStyle.color).toBe(getComputedStyle(firstOption(container).description).color);
        expect(eyebrowStyle.color).not.toBe(questionStyle.color);
      }

      if (collapsedText === null) return;
      await act(async () => trigger.click());
      expect(trigger.dataset.pendingUserInputToggle).toBe("collapsed");
      expect(trigger.textContent).toBe(collapsedText);

      await act(async () => trigger.click());
      expect(trigger.dataset.pendingUserInputToggle).toBe("expanded");
      expect(trigger.textContent).toBe("");
    });
  },
);

it.each([
  ["generic header", false, "mobile", 414],
  ["generic header", false, "sm", 1024],
  ["generic multi-select header", true, "mobile", 414],
  ["generic multi-select header", true, "sm", 1024],
  ["eyebrow", false, "mobile", 414],
  ["eyebrow", false, "sm", 1024],
])(
  "starts the leading %s beside the actions without overlapping them at %s width",
  async (lead, multiSelect, _, width) => {
    await page.viewport(width, 900);
    // One unbreakable run fills every line, so only the first line's width reflects the actions.
    const run = "x".repeat(200);
    await renderPanel(
      lead === "eyebrow"
        ? { header: run, question: "Pick one.", questionCount: 3 }
        : { header: "Question", question: run, questionCount: 3, multiSelect },
      async (container) => {
        const trigger = container.querySelector<HTMLElement>("[data-pending-user-input-toggle]")!;
        const actions = trigger.querySelector("[data-slot=composer-banner-actions]")!;
        const paragraph = container.querySelector("p")!;
        expect(paragraph.textContent).toBe(run);
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const [firstLine, secondLine] = range.getClientRects();
        const actionsRect = actions.getBoundingClientRect();
        const paragraphRect = paragraph.getBoundingClientRect();
        expect(paragraphRect.top).toBeLessThan(trigger.getBoundingClientRect().bottom);
        const firstLineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
        expect(firstLineHeight).toBe(lead === "eyebrow" ? 16 : 20);
        expect(paragraphRect.top + firstLineHeight / 2).toBeCloseTo(
          actionsRect.top + actionsRect.height / 2,
          0,
        );
        expect(firstLine!.right).toBeLessThanOrEqual(actionsRect.left);
        expect(secondLine!.right).toBeGreaterThan(actionsRect.left);

        const actionText = [...actions.querySelectorAll("span")].map((span) => span.textContent);
        expect(actionText.includes("Select any")).toBe(multiSelect);
        const count = [...actions.querySelectorAll("span")].find(
          (element) => element.textContent === "1/3",
        )!;
        expect(getComputedStyle(count).fontSize).toBe("12px");
        const caret = actions.querySelector("svg")!;
        const countToCaret =
          caret.getBoundingClientRect().left - count.getBoundingClientRect().right;
        expect(countToCaret).toBeGreaterThanOrEqual(0);
        expect(countToCaret).toBeLessThanOrEqual(4);
      },
    );
  },
);

it("counts a single-question prompt across its simultaneous queue", async () => {
  await page.viewport(1024, 900);
  await renderPanel({ header: "Strategy", queue: { index: 2, total: 5 } }, async (container) => {
    const actions = container.querySelector("[data-slot=composer-banner-actions]")!;
    const spans = [...actions.querySelectorAll("span")].map((span) => span.textContent);
    expect(spans).toContain("3/5");
  });
});

it.each([
  ["wide", 640, true],
  ["narrow", 320, false],
])(
  "keeps descriptions on the label's line when %s and pins the indicator to line one",
  async (_, width, sharesLine) => {
    await page.viewport(1024, 900);
    const longLabel = "Roll out one availability zone at a time ".repeat(3);
    await renderPanel(
      {
        header: "Strategy",
        width,
        options: [
          { label: "Rolling", description: "One node at a time" },
          { label: longLabel, description: "Slower, but every step is reversible" },
          { label: "Same", description: "Same" },
        ],
      },
      async (container) => {
        const [short, long, bare] = [...container.querySelectorAll("button[aria-pressed]")].map(
          (row) => {
            const [label, description] = row.querySelectorAll("span");
            return {
              row: row.getBoundingClientRect(),
              label: label!.getBoundingClientRect(),
              description: description!,
              key: row.querySelector("[data-pending-user-input-option-key]")!,
            };
          },
        );
        const descriptionRect = short!.description.getBoundingClientRect();
        if (sharesLine) {
          // 12/20 description shares the label's 14/20 line; baseline alignment offsets its box by a pixel.
          expect(Math.abs(descriptionRect.top - short!.label.top)).toBeLessThanOrEqual(1);
          expect(descriptionRect.left - short!.label.right).toBeGreaterThanOrEqual(16);
          expect(getComputedStyle(short!.description).lineHeight).toBe("20px");
        } else {
          expect(descriptionRect.left).toBe(short!.label.left);
          expect(descriptionRect.top - short!.label.bottom).toBe(2);
          expect(getComputedStyle(short!.description).lineHeight).toBe("16px");
        }
        // A wrapped label keeps its indicator beside the first line.
        expect(long!.label.height).toBeGreaterThan(20);
        expect(long!.key.getBoundingClientRect().top).toBe(long!.label.top);
        expect(centerX(long!.key)).toBe(centerX(short!.key));
        expect(short!.row.height).toBe(sharesLine ? 36 : 54);
        // A description that repeats the label is dropped.
        expect(bare!.description.textContent).toBe("");
        expect(bare!.row.height).toBe(36);
      },
    );
  },
);

it("renders a custom-answer option as a static downward hint after selectable options", async () => {
  await page.viewport(1024, 900);
  await renderPanel(
    {
      header: "Theme",
      options: [
        { label: "System", description: "Follow the OS" },
        { label: "Dark", description: "Always dark" },
        {
          label: "Write my own answer",
          description: "Write my own answer",
          customAnswer: true,
        },
      ],
    },
    async (container) => {
      const selectableRows = [...container.querySelectorAll("button[aria-pressed]")];
      expect(
        selectableRows.map(
          (row) => row.querySelector("[data-pending-user-input-option-key]")?.textContent,
        ),
      ).toEqual(["1", "2"]);

      const customAnswerRow = container.querySelector<HTMLElement>(
        "[data-pending-user-input-custom-answer-option]",
      )!;
      expect(customAnswerRow.tagName).toBe("DIV");
      expect(customAnswerRow.getAttribute("aria-pressed")).toBeNull();
      expect(customAnswerRow.textContent).toContain("Write my own answer");
      expect(customAnswerRow.querySelector("svg")).not.toBeNull();
      expect(customAnswerRow.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        selectableRows.at(-1)!.getBoundingClientRect().bottom,
      );

      const selectableKey = selectableRows[0]!.querySelector(
        "[data-pending-user-input-option-key]",
      )!;
      const customAnswerIcon = customAnswerRow.querySelector("svg")!;
      expect(centerX(customAnswerIcon)).toBe(centerX(selectableKey));
    },
  );
});
