import { expect, it } from "vite-plus/test";
import type { ScreenHeaderMenuItem } from "../../components/ScreenHeader.types";
import { nativeLifecycleItems } from "./threadConversationNativeMenu";

it("retained native actions use the current target and eligibility", () => {
  const archived: string[] = [];
  let current: ReadonlyArray<ScreenHeaderMenuItem> = [
    { id: "archive", title: "Archive", onPress: () => archived.push("idle") },
  ];
  const retained = nativeLifecycleItems(current, () => current)[0]!;
  const press = retained.onPress as () => void;
  let running = true;
  current = [
    {
      id: "archive",
      title: "Archive",
      onPress: () => {
        if (!running) archived.push("current");
      },
    },
  ];
  press();
  expect(archived).toEqual([]);
  running = false;
  press();
  expect(archived).toEqual(["current"]);
});

it.each(["disabled", "removed"])("does not invoke a %s action retained by native UI", (state) => {
  let calls = 0;
  const action = { id: "regenerate", title: "Regenerate title", onPress: () => calls++ };
  let current: ReadonlyArray<ScreenHeaderMenuItem> = [action];
  const press = nativeLifecycleItems(current, () => current)[0]!.onPress as () => void;
  current = state === "disabled" ? [{ ...action, disabled: true }] : [];
  press();
  expect(calls).toBe(0);
});

it("retained submenu actions resolve the current child", () => {
  const calls: string[] = [];
  const menu = (target: string): ReadonlyArray<ScreenHeaderMenuItem> => [
    {
      id: "organize",
      title: "Organize",
      items: [{ id: "pin", title: "Pin", onPress: () => calls.push(target) }],
    },
  ];
  let current = menu("old");
  const retained = nativeLifecycleItems(current, () => current)[0]!;
  const press = (retained.items as Array<Record<string, unknown>>)[0]!.onPress as () => void;
  current = menu("new");
  press();
  expect(calls).toEqual(["new"]);
  current = [];
  press();
  expect(calls).toEqual(["new"]);
});
