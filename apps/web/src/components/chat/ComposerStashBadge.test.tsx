import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ComposerStashBadge } from "./ComposerStashBadge";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("keeps the status region mounted and replaces its announcement for rapid saves", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const props = { count: 0, menuOpen: false, pulseKey: 0, pulsing: false, onToggleMenu: vi.fn() };
  await act(async () => {
    renderer = create(<ComposerStashBadge {...props} />);
  });
  const region = renderer!.root.findByProps({ role: "status" });
  expect(region.children).toEqual([]);
  await act(async () => {
    renderer!.update(<ComposerStashBadge {...props} pulseKey={1} pulsing />);
  });
  const firstAnnouncement = region.children[0];
  await act(async () => {
    renderer!.update(<ComposerStashBadge {...props} pulseKey={2} pulsing />);
  });
  expect(renderer!.root.findByProps({ role: "status" })).toBe(region);
  expect(region.children[0]).not.toBe(firstAnnouncement);
});
