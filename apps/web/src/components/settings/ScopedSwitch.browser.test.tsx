import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ScopedSwitch } from "./ScopedSwitch";

// Whether the selected environments disagree, as they report it after each save.
const environments = vi.hoisted(() => ({ mixed: false }));

vi.mock(import("./useScopedSettings"), () => ({
  useScopedSettingsMixed: () => environments.mixed,
}));

function setup() {
  environments.mixed = true;
}

it("turns a mixed setting on, then off when an older environment drops it", async () => {
  setup();
  const saves: boolean[] = [];
  const row = () => (
    <ScopedSwitch
      settingKeys={["linkedEnvironmentsEnabled"]}
      checked={false}
      onCheckedChange={(next) => saves.push(next)}
      aria-label="Linked environments"
    />
  );
  await using screen = await render(row());
  const toggle = screen.getByRole("switch");

  await userEvent.click(toggle);
  expect(saves).toEqual([true]);
  // The older environment dropped the unknown key, so the row is still mixed.
  await screen.rerender(row());
  await expect.element(toggle).toHaveAttribute("aria-checked", "mixed");
  await expect.element(toggle).toHaveAttribute("data-unchecked");

  await userEvent.click(toggle);
  environments.mixed = false;
  await screen.rerender(row());

  expect(saves).toEqual([true, false]);
  await expect.element(toggle).toHaveAttribute("aria-checked", "false");
});
