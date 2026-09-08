import { act, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, vi } from "vite-plus/test";

export function setupReactTestRenderer(): void {
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(() => vi.unstubAllGlobals());
}

export function renderText(element: ReactElement): string {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  const text = renderer.root
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ")
    .replace(/\s+/gu, " ");
  act(() => renderer.unmount());
  return text;
}
