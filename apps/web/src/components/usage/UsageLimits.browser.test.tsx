import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ResetCredits } from "./UsageLimits";

const state = vi.hoisted(() => ({ consume: vi.fn() }));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: (() => state.consume) as never,
}));
vi.mock(import("~/state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));

const desk = EnvironmentId.make("desk");
const remote = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("claude_work");

it("spends the credit and destination the dialog opened for, even after a refresh", async () => {
  state.consume.mockReset().mockResolvedValue({ _tag: "Success", value: { outcome: "noCredit" } });
  await using screen = await render(
    <ResetCredits
      environmentId={desk}
      input={{ instanceId }}
      credits={{ availableCount: 2, nextCreditId: "general" }}
      now={0}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Use reset" }));
  await screen.rerender(
    <ResetCredits
      environmentId={remote}
      input={{ instanceId: ProviderInstanceId.make("claude_alice") }}
      credits={{
        availableCount: 1,
        nextCreditId: "fable",
        clears: "Clears Session and Weekly · Fable",
      }}
      now={0}
    />,
  );
  await expect
    .element(
      screen.getByText(
        "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
      ),
    )
    .toBeVisible();
  // Base UI's inert backdrop intercepts synthetic pointer events in the test frame.
  (screen.getByRole("button", { name: "Use credit" }).element() as HTMLElement).click();

  await vi.waitFor(() =>
    expect(state.consume).toHaveBeenCalledWith({
      environmentId: desk,
      input: { instanceId, creditId: "general" },
    }),
  );
});
