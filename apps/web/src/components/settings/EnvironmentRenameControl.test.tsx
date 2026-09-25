import { EnvironmentId } from "@t3tools/contracts";
import { act, type ButtonHTMLAttributes, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogPopup: ({ children }: { children: ReactNode }) => children,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => children,
  DialogDescription: ({ children }: { children: ReactNode }) => children,
  DialogPanel: ({ children }: { children: ReactNode }) => children,
  DialogFooter: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/input", () => ({
  Input: (props: { value: string; onChange: (event: { target: { value: string } }) => void }) => (
    <input {...props} />
  ),
}));

import { PrimaryEnvironmentRenameControl } from "./EnvironmentRenameControl";

describe("current environment rename", () => {
  it("shows a visible Edit name action and saves the shared T3 Connect name", async () => {
    const environmentId = EnvironmentId.make("this-machine");
    const onRename = vi.fn().mockResolvedValue(true);
    let renderer!: ReactTestRenderer;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(
        <PrimaryEnvironmentRenameControl
          environment={{ environmentId, label: "MacBook Pro" }}
          isSaving={false}
          onRename={onRename}
        />,
      );
    });

    const renameButton = renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Edit name"));
    expect(renameButton).toBeDefined();
    await act(async () => renameButton!.props.onClick());
    await act(async () =>
      renderer.root.findByType("input").props.onChange({ target: { value: "Work" } }),
    );
    const saveButton = renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Save"));
    await act(async () => saveButton!.props.onClick());
    expect(onRename).toHaveBeenCalledWith(environmentId, "Work");
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it("keeps the rename entry visible but unavailable before this machine is linked", async () => {
    let renderer!: ReactTestRenderer;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(
        <PrimaryEnvironmentRenameControl environment={null} isSaving={false} onRename={vi.fn()} />,
      );
    });
    const renameButton = renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Edit name"));
    expect(renameButton?.props.disabled).toBe(true);
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it("can restore the default name from the current environment dialog", async () => {
    const environmentId = EnvironmentId.make("this-machine");
    const onRename = vi.fn().mockResolvedValue(true);
    let renderer!: ReactTestRenderer;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(
        <PrimaryEnvironmentRenameControl
          environment={{ environmentId, label: "Work" }}
          isSaving={false}
          onRename={onRename}
        />,
      );
    });
    const button = (label: string) =>
      renderer.root.findAllByType("button").find((item) => item.children.includes(label))!;
    await act(async () => button("Edit name").props.onClick());
    await act(async () => button("Restore default name").props.onClick());
    expect(onRename).toHaveBeenCalledWith(environmentId, null);
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });
});
