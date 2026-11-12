import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), mathRenderingEnabled: true };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import { render } from "../../../test/render";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

it("typesets math in option labels and descriptions like the question", async () => {
  await using screen = await render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[
        {
          requestId: RuntimeRequestId.make("question-math"),
          createdAt: "2026-11-12T00:00:00.000Z",
          dismissible: false,
          responseCapability: "live",
          questions: [
            {
              id: "series",
              header: "Series",
              question: "What does $\\sum_{n=1}^{\\infty} \\frac{1}{2^n}$ equal?",
              options: [
                { label: "$1$", description: "Converges to $1$" },
                { label: "$\\frac{1}{2}$", description: "Half of $1$" },
              ],
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
    />,
  );

  const equations = screen.getByRole("group", { name: "Inline equation" });
  await expect.element(equations.first()).toBeVisible();
  await expect.element(equations.nth(4)).toBeVisible();
  await expect.element(screen.getByText("$\\frac{1}{2}$", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Half of $1$", { exact: true })).not.toBeInTheDocument();
});
