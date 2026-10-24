import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (index === hooks.values.length) hooks.values.push(initial);
    return [hooks.values[index], (value: unknown) => (hooks.values[index] = value)];
  },
  useRef: (current: unknown) => {
    const index = hooks.index++;
    if (index === hooks.values.length) hooks.values.push({ current });
    return hooks.values[index];
  },
  useEffect: () => {},
}));

import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";

function saveButton(node: ReactNode): { onClick: () => Promise<void>; disabled: boolean } {
  const button = findSaveButton(node);
  if (!button) throw new Error("Save icon button not found");
  return button;
}

function findSaveButton(
  node: ReactNode,
): { onClick: () => Promise<void>; disabled: boolean } | undefined {
  if (
    !isValidElement<{ children?: ReactNode; onClick: () => Promise<void>; disabled: boolean }>(node)
  )
    return;
  if (node.props.children === "Save icon") return node.props;
  for (const child of [node.props.children].flat()) {
    const button = findSaveButton(child);
    if (button) return button;
  }
}

beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
});

it("unlocks saving and dismissal when formatting a rejected save also throws", async () => {
  const formattingFailure = new Error("Cannot read error cause");
  const rejection = {
    get cause(): unknown {
      throw formattingFailure;
    },
  };
  const onSelect = vi.fn().mockRejectedValueOnce(rejection).mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  const render = () => {
    hooks.index = 0;
    return ProjectIconPickerDialog({
      current: { kind: "emoji", emoji: "💻" },
      projectName: "Project",
      open: true,
      onSelect,
      onOpenChange,
    });
  };

  const saving = saveButton(render()).onClick();
  expect(saveButton(render()).disabled).toBe(true);
  await expect(saving).rejects.toBe(formattingFailure);
  expect(onOpenChange).not.toHaveBeenCalled();

  const recovered = render();
  expect(saveButton(recovered).disabled).toBe(false);
  recovered.props.onOpenChange(false);
  expect(onOpenChange).toHaveBeenCalledWith(false);

  onOpenChange.mockClear();
  await saveButton(recovered).onClick();
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(saveButton(render()).disabled).toBe(false);
});
