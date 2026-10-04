// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { installDashboardPopupHost, openAgentDashboardWindow } from "./dashboardPopup";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
});
it("reuses one portal window, follows theme changes, and releases observers and listeners", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const child = frame.contentWindow!;
  const focus = vi.spyOn(child, "focus").mockImplementation(() => {});
  const close = vi.spyOn(child, "close").mockImplementation(() => {});
  const open = vi.spyOn(window, "open").mockReturnValue(child);
  const changes: (Window | null)[] = [];
  const dispose = installDashboardPopupHost((value) => changes.push(value));
  openAgentDashboardWindow();
  openAgentDashboardWindow();
  expect(open).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenCalledTimes(1);
  expect(changes).toEqual([child]);
  document.documentElement.setAttribute("data-theme", "dark");
  await Promise.resolve();
  expect(child.document.documentElement.getAttribute("data-theme")).toBe("dark");
  child.dispatchEvent(new Event("beforeunload"));
  expect(changes.at(-1)).toBeNull();
  document.documentElement.setAttribute("data-theme", "light");
  await Promise.resolve();
  expect(child.document.documentElement.getAttribute("data-theme")).toBe("dark");
  openAgentDashboardWindow();
  dispose();
  expect(close).toHaveBeenCalledTimes(1);
  openAgentDashboardWindow();
  expect(open).toHaveBeenCalledTimes(2);
});
