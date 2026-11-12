import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  assigneeIsPresent,
  buildPermissionRequestRouting,
  DEFAULT_PERMISSION_ROUTING_POLICY,
  isPermissionApprovalKind,
  isPermissionRoutedToSession,
  nobodyPermitResolvedBy,
  shouldPermitWhenNobody,
} from "./permissionRouting.ts";

const routedAt = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");

describe("permissionRouting", () => {
  it("treats provider approval kinds as routable and skips questions", () => {
    expect(isPermissionApprovalKind("command")).toBe(true);
    expect(isPermissionApprovalKind("permission")).toBe(true);
    expect(isPermissionApprovalKind("user_input")).toBe(false);
  });

  it("defaults to any-operator wait, matching today's broadcast behavior", () => {
    expect(DEFAULT_PERMISSION_ROUTING_POLICY).toEqual({
      defaultApprover: { type: "any-operator" },
      whenNobody: "wait",
    });
    expect(buildPermissionRequestRouting(DEFAULT_PERMISSION_ROUTING_POLICY, routedAt)).toEqual({
      assignee: { type: "any-operator" },
      whenNobody: "wait",
      routedAt,
    });
  });

  it("detects a connected operator for any-operator and a matching subject", () => {
    const sessions = [
      {
        subject: "alice",
        connected: true,
        scopes: ["orchestration:operate"],
      },
      {
        subject: "bob",
        connected: false,
        scopes: ["orchestration:operate"],
      },
    ];
    expect(assigneeIsPresent({ type: "any-operator" }, sessions)).toBe(true);
    expect(assigneeIsPresent({ type: "subject", subject: "alice" }, sessions)).toBe(true);
    expect(assigneeIsPresent({ type: "subject", subject: "bob" }, sessions)).toBe(false);
    expect(assigneeIsPresent({ type: "any-operator" }, [])).toBe(false);
  });

  it("ignores connected sessions that cannot operate", () => {
    const sessions = [
      {
        subject: "reader",
        connected: true,
        scopes: ["orchestration:read"],
      },
    ];
    expect(assigneeIsPresent({ type: "any-operator" }, sessions)).toBe(false);
    expect(assigneeIsPresent({ type: "subject", subject: "reader" }, sessions)).toBe(false);
  });

  it("permits only when policy says so and nobody matching is present", () => {
    const alice = {
      subject: "alice",
      connected: true,
      scopes: ["orchestration:operate" as const],
    };
    expect(
      shouldPermitWhenNobody({ assignee: { type: "any-operator" }, whenNobody: "permit" }, []),
    ).toBe(true);
    expect(
      shouldPermitWhenNobody({ assignee: { type: "any-operator" }, whenNobody: "permit" }, [alice]),
    ).toBe(false);
    expect(
      shouldPermitWhenNobody({ assignee: { type: "any-operator" }, whenNobody: "wait" }, []),
    ).toBe(false);
    expect(
      shouldPermitWhenNobody(
        { assignee: { type: "subject", subject: "alice" }, whenNobody: "permit" },
        [{ ...alice, subject: "bob" }],
      ),
    ).toBe(true);
  });

  it("records an audited policy-nobody-permit resolution", () => {
    expect(nobodyPermitResolvedBy({ assignee: { type: "any-operator" } })).toEqual({
      source: "policy-nobody-permit",
      detail: "No connected operator was available; permitted by permission-routing policy.",
    });
    expect(nobodyPermitResolvedBy({ assignee: { type: "subject", subject: "alice" } })).toEqual({
      source: "policy-nobody-permit",
      detail: 'Assignee subject "alice" was not connected; permitted by permission-routing policy.',
    });
  });

  it("soft-matches routed sessions for UI attention", () => {
    const alice = {
      subject: "alice",
      connected: true,
      scopes: ["orchestration:operate"],
    };
    expect(isPermissionRoutedToSession({ assignee: { type: "any-operator" } }, alice)).toBe(true);
    expect(
      isPermissionRoutedToSession({ assignee: { type: "subject", subject: "alice" } }, alice),
    ).toBe(true);
    expect(
      isPermissionRoutedToSession(
        { assignee: { type: "subject", subject: "alice" } },
        { ...alice, subject: "bob" },
      ),
    ).toBe(false);
  });
});
