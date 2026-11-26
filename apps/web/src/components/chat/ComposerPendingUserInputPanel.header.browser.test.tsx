import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), () => ({
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { render } from "../../../test/render";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

import "~/index.css";

const header =
  "Pick how the migration should be rolled out across the three production regions before Friday";

const renderPanel = () =>
  render(
    <div style={{ width: "320px" }}>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId: RuntimeRequestId.make("question-header"),
            createdAt: "2026-11-25T00:00:00.000Z",
            dismissible: false,
            responseCapability: "live",
            questions: [
              {
                id: "question",
                header,
                question: "How should this ship?",
                options: [{ label: "One region", description: "Start with EU" }],
                multiSelect: false,
              },
            ],
          },
        ]}
        cwd={undefined}
        threadRef={{ environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") }}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
        onDismiss={() => {}}
      />
    </div>,
  );

/** The innermost span carrying the header text; the banner content wraps it. */
const headerLabel = (container: HTMLElement) =>
  [...container.querySelectorAll("span")].filter((span) => span.textContent === header).at(-1)!;

it("wraps a long header so the expanded card shows all of it", async () => {
  await using screen = await renderPanel();

  const label = headerLabel(screen.container);
  const style = getComputedStyle(label);
  expect(style.textOverflow).not.toBe("ellipsis");
  expect(style.whiteSpace).not.toBe("nowrap");
});

it("still collapses the question when the wrapped header is clicked", async () => {
  await using screen = await renderPanel();

  headerLabel(screen.container).click();

  await expect.element(screen.getByTitle("Show the question and its options")).toBeVisible();
});
