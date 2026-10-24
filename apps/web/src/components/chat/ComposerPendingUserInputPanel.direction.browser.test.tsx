import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), () => ({
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { render } from "../../../test/render";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

it("gives Hebrew question text its own direction without flipping the option rows", async () => {
  await using screen = await render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[
        {
          requestId: RuntimeRequestId.make("question-direction"),
          createdAt: "2026-10-23T00:00:00.000Z",
          dismissible: false,
          responseCapability: "live",
          questions: [
            {
              id: "question",
              header: "גישה",
              question: "איך לבצע את המיגרציה?",
              multiSelect: false,
              options: [
                {
                  label: "React Server Components בכל המסכים של האפליקציה",
                  description: "מסך אחד בכל פעם",
                },
              ],
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
    />,
  );

  const text = (value: string) => screen.getByText(value, { exact: true });
  await expect.element(text("גישה")).toHaveStyle({ direction: "rtl" });
  await expect
    .element(text("React Server Components בכל המסכים של האפליקציה"))
    .toHaveStyle({ direction: "rtl" });
  await expect.element(text("מסך אחד בכל פעם")).toHaveStyle({ direction: "rtl" });
  await expect
    .element(screen.getByRole("button", { name: /React Server/ }))
    .toHaveStyle({ direction: "ltr" });

  await screen.getByTitle("Hide the question and its options").click();
  await expect.element(text("איך לבצע את המיגרציה?")).toHaveStyle({ direction: "rtl" });
});
