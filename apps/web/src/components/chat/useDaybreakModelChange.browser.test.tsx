import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { useDaybreakModelChange } from "./useDaybreakModelChange";

const option = (value: string) => [{ id: "cyberAccessProgram", value }];

function ModelChange({
  onCommit,
  restored = false,
}: {
  onCommit: (selection: ModelSelection) => void;
  restored?: boolean;
}) {
  const descriptors: ProviderOptionDescriptor[] = [
    {
      id: "cyberAccessProgram",
      label: "Daybreak",
      type: "select",
      options: ["standard", "daybreakBlue", ...(restored ? ["daybreakRed"] : [])].map((id) => ({
        id,
        label: id,
      })),
    },
  ];
  const { requestModelChange, daybreakDialog } = useDaybreakModelChange(() => descriptors, "test");
  const target = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" };
  return (
    <>
      <button onClick={() => requestModelChange(option("daybreakRed"), target, onCommit)}>
        Switch model
      </button>
      {daybreakDialog}
    </>
  );
}

it("keeps an explicit Off choice when the source program is restored before confirmation", async () => {
  const onCommit = vi.fn();
  await using screen = await render(<ModelChange onCommit={onCommit} />);
  await page.getByRole("button", { name: "Switch model", exact: true }).click();
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  // A catalog refresh is independent of the user's pending decision.
  await screen.rerender(<ModelChange onCommit={onCommit} restored />);
  await page.getByRole("button", { name: "Turn Off", exact: true }).click();
  expect(onCommit).toHaveBeenCalledWith({
    instanceId: "codex",
    model: "gpt-6-luna",
    options: option("standard"),
  });
});
