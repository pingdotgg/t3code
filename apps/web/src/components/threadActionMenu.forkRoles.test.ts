import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";
import { forkRoleFromMenuId } from "./threadActionMenu.forkRoles";

const list = {
  directory: "/roles",
  roles: [
    { id: "needs-you", name: "Needs you", path: "/roles/needs-you.md" },
    { id: "coordinator", name: "Coordinator", path: "/roles/coordinator.md" },
  ],
};
const state: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: resolveSnoozePresets(new Date("2026-11-23T12:00:00Z")),
  forkRoles: { current: null, list },
};
const roleItem = (overrides: Partial<ThreadActionMenuState>) =>
  buildThreadActionMenuItems({ ...state, ...overrides }).find((item) => item.id === "role");

describe("Role menu item", () => {
  it("lists every role, with no way to clear a role that is not set", () => {
    expect(roleItem({})?.children).toEqual([
      { id: "role:set:needs-you", label: "Needs you", checked: false },
      { id: "role:set:coordinator", label: "Coordinator", checked: false },
    ]);
  });

  it("checks the current role and offers No role", () => {
    const children = roleItem({ forkRoles: { current: "coordinator", list } })?.children ?? [];
    expect(children.filter((child) => child.checked).map((child) => child.id)).toEqual([
      "role:set:coordinator",
    ]);
    expect(children.at(-1)).toMatchObject({ id: "role:none", label: "No role" });
  });

  it("is disabled with a hint while loading, or without a roles directory, roles, or permission", () => {
    expect(roleItem({ forkRoles: { current: null, list: null } })).toMatchObject({
      disabled: true,
      detail: "Loading roles…",
    });
    expect(
      roleItem({ forkRoles: { current: null, list: { directory: null, roles: [] } } }),
    ).toMatchObject({ disabled: true, detail: "Set a roles directory in Settings" });
    expect(roleItem({ forkRoles: { current: null, list: { ...list, roles: [] } } })).toMatchObject({
      disabled: true,
      detail: "No roles in the roles directory",
    });
    const readOnly = roleItem({ canOperate: false });
    expect(readOnly?.disabled).toBe(true);
    expect(readOnly?.children?.every((child) => child.disabled)).toBe(true);
  });

  it("is absent when the caller supplies no role state", () => {
    const { forkRoles: _, ...withoutRoles } = state;
    expect(
      buildThreadActionMenuItems(withoutRoles).find((item) => item.id === "role"),
    ).toBeUndefined();
  });
});

describe("forkRoleFromMenuId", () => {
  it("reads a role, No role, or nothing", () => {
    expect(forkRoleFromMenuId("role:set:needs-you")).toBe("needs-you");
    expect(forkRoleFromMenuId("role:none")).toBeNull();
    expect(forkRoleFromMenuId("snooze:custom")).toBeUndefined();
  });
});
