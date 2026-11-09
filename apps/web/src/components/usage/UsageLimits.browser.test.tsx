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

const environmentId = EnvironmentId.make("desk");
const instanceId = ProviderInstanceId.make("claude_work");

function credits(id: string) {
  return { availableCount: 1, nextCreditId: id };
}

it("spends the credit the dialog opened for, even after a refresh offers another", async () => {
  state.consume.mockReset().mockResolvedValue({ _tag: "Success", value: { outcome: "noCredit" } });
  await using screen = await render(
    <ResetCredits
      environmentId={environmentId}
      input={{ instanceId }}
      credits={credits("fable")}
      now={0}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Use reset" }));
  await screen.rerender(
    <ResetCredits
      environmentId={environmentId}
      input={{ instanceId }}
      credits={credits("general")}
      now={0}
    />,
  );
  const confirm = screen.getByRole("button", { name: "Use credit" });
  await expect.element(confirm).toBeVisible();
  // Base UI's inert backdrop intercepts synthetic pointer events in the test frame.
  (confirm.element() as HTMLElement).click();

  await vi.waitFor(() =>
    expect(state.consume).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, creditId: "fable" },
    }),
  );
});
