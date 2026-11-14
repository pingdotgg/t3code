import type { OrbitGatewayEnvironment } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_ORBIT_NAME_FIELD,
  ORBIT_INSTANCE_EXPIRED_REASON,
  ORBIT_INSTANCE_STOPPED_REASON,
  ORBIT_NAME_CHECK_UNAVAILABLE,
  ORBIT_NAME_CHECKING,
  ORBIT_NAME_EMPTY_ERROR,
  ORBIT_NAME_FORMAT_ERROR,
  ORBIT_NAME_HINT,
  buildOrbitInstanceRows,
  cleanOrbitInstanceSlug,
  filterOrbitInstanceRows,
  isOrbitInstanceNameFormatValid,
  orbitCloneProject,
  orbitInstancePick,
  orbitInstanceRowSubline,
  orbitNameCheckFailure,
  orbitNameFieldForSearch,
  orbitNameHint,
  typedOrbitNameField,
  type OrbitNameCheckState,
} from "./orbitInstanceStepLogic";

describe("Orbit Instance name rule", () => {
  it.each([
    ["pricing", true],
    ["fix-login-2", true],
    ["a".repeat(63), true],
    ["a".repeat(64), false],
    ["default", false],
    ["Pricing", false],
    ["-pricing", false],
    ["pricing-", false],
    ["pri--cing", false],
    ["pri_cing", false],
    ["", false],
  ])("%s → %s", (name, valid) => {
    expect(isOrbitInstanceNameFormatValid(name)).toBe(valid);
  });

  it.each([
    ["New Page", "new-page"],
    ["  --Fix: login_flow!! ", "fix-login-flow"],
    ["ÄÖ", ""],
    [`${"a".repeat(62)} b`, "a".repeat(62)],
  ])("cleans the search text %j to %j", (text, slug) => {
    expect(cleanOrbitInstanceSlug(text)).toBe(slug);
  });
});

describe("Orbit name field and search", () => {
  it("fills the name from a search without a match and drops it when the search matches or clears", () => {
    const filled = orbitNameFieldForSearch(EMPTY_ORBIT_NAME_FIELD, {
      query: "New Page",
      matchCount: 0,
    });
    expect(filled).toEqual({ value: "new-page", source: "search" });
    expect(orbitNameFieldForSearch(filled, { query: "fix", matchCount: 1 })).toEqual(
      EMPTY_ORBIT_NAME_FIELD,
    );
    expect(orbitNameFieldForSearch(filled, { query: "", matchCount: 0 })).toEqual(
      EMPTY_ORBIT_NAME_FIELD,
    );
  });

  it("never overwrites a name the user typed", () => {
    const typed = typedOrbitNameField("mine");
    expect(orbitNameFieldForSearch(typed, { query: "other", matchCount: 0 })).toBe(typed);
    expect(orbitNameFieldForSearch(typed, { query: "", matchCount: 3 })).toBe(typed);
    expect(typedOrbitNameField("")).toEqual(EMPTY_ORBIT_NAME_FIELD);
  });
});

describe("Orbit name check states", () => {
  const hint = (name: string, check: OrbitNameCheckState, submitted = false) =>
    orbitNameHint({ name, check, projectName: "nckrtl", submitted });
  const answered = (
    name: string,
    answer: Partial<{
      available: boolean;
      reason: "taken" | "invalid" | "default" | "domain_invalid" | null;
      domain: string | null;
    }>,
  ): OrbitNameCheckState => ({
    status: "answered",
    name,
    answer: { name, available: false, reason: null, domain: null, ...answer },
  });

  it("shows the neutral hint, and asks for a name only after a press", () => {
    expect(hint("", { status: "idle" })).toMatchObject({
      tone: "neutral",
      text: ORBIT_NAME_HINT,
      canCreate: false,
    });
    expect(hint("", { status: "idle" }, true)).toMatchObject({
      tone: "bad",
      text: ORBIT_NAME_EMPTY_ERROR,
    });
  });

  it("rejects a bad format at once, without a check", () => {
    expect(hint("Bad Name", { status: "idle" })).toMatchObject({
      tone: "bad",
      text: ORBIT_NAME_FORMAT_ERROR,
      plusEnabled: true,
      canCreate: false,
    });
  });

  it("turns the plus off while the check runs, also when the answer is for an older name", () => {
    expect(hint("pricing", { status: "checking", name: "pricing" })).toMatchObject({
      text: ORBIT_NAME_CHECKING,
      plusEnabled: false,
      canCreate: false,
    });
    expect(hint("pricing", answered("pric", { available: true }))).toMatchObject({
      text: ORBIT_NAME_CHECKING,
      plusEnabled: false,
    });
  });

  it("reads available by the name alone (never the address), taken, and an address too long", () => {
    expect(
      hint("pricing", answered("pricing", { available: true, domain: "pricing.nckrtl.test" })),
    ).toMatchObject({
      tone: "ok",
      text: "pricing is available.",
      canCreate: true,
    });
    expect(hint("pricing", answered("pricing", { available: true }))).toMatchObject({
      text: "pricing is available.",
      canCreate: true,
    });
    expect(hint("fix", answered("fix", { reason: "taken" }))).toMatchObject({
      tone: "bad",
      text: "fix is taken in nckrtl.",
      canCreate: false,
    });
    expect(hint("fix", answered("fix", { reason: "invalid" }))).toMatchObject({
      text: ORBIT_NAME_FORMAT_ERROR,
      canCreate: false,
    });
    const long = "a-very-long-name-for-this-project";
    expect(hint(long, answered(long, { reason: "domain_invalid" }))).toEqual({
      tone: "bad",
      text: "This name makes the address too long. Use a shorter name.",
      plusEnabled: true,
      canCreate: false,
    });
  });

  it("treats default_missing as cannot create here, and a failed check as unavailable with the plus on", () => {
    const missing = orbitNameCheckFailure("pricing", {
      code: "instance.default_missing",
      message: "The default Instance is not ready.",
    });
    expect(missing).toEqual({
      status: "cannot-create",
      name: "pricing",
      message: "The default Instance is not ready.",
    });
    expect(hint("pricing", missing)).toMatchObject({
      tone: "bad",
      text: "The default Instance is not ready.",
      plusEnabled: false,
      canCreate: false,
    });
    // Another name is checked again rather than blocked by the old answer.
    expect(hint("pricing-two", missing)).toMatchObject({ text: ORBIT_NAME_CHECKING });
    for (const error of [new Error("timeout"), { code: "gateway.unreachable" }, null]) {
      const unavailable = orbitNameCheckFailure("pricing", error);
      expect(unavailable.status).toBe("unavailable");
      expect(hint("pricing", unavailable)).toMatchObject({
        text: ORBIT_NAME_CHECK_UNAVAILABLE,
        plusEnabled: true,
        canCreate: true,
      });
    }
  });
});

describe("Existing Orbit instances", () => {
  const environment = (
    overrides: Partial<OrbitGatewayEnvironment> & Pick<OrbitGatewayEnvironment, "instanceId">,
  ): OrbitGatewayEnvironment => ({
    environmentId: `env-${overrides.instanceId}`,
    label: "label",
    url: "https://t3.example.test",
    serverVersion: null,
    registeredBy: "another-device",
    registeredAt: null,
    status: "registered",
    powerState: "running",
    projectId: 3,
    projectName: "nckrtl",
    projectSlug: "nckrtl",
    instanceName: `i${overrides.instanceId}`,
    nodeName: "beast",
    instanceUrl: `https://i${overrides.instanceId}.nckrtl.test`,
    ...overrides,
  });
  const thread = (environmentId: string, updatedAt: string, archivedAt: string | null = null) => ({
    environmentId,
    updatedAt,
    archivedAt,
  });

  const rows = buildOrbitInstanceRows({
    projectId: 3,
    environments: [
      environment({ instanceId: 1, instanceName: "fix" }),
      environment({
        instanceId: 1,
        instanceName: "fix",
        environmentId: "env-1-old",
        status: "session_expired",
      }),
      environment({ instanceId: 2, instanceName: "login", registeredBy: "this-device" }),
      environment({ instanceId: 3, instanceName: "sleepy", powerState: "stopped" }),
      environment({ instanceId: 4, instanceName: "expired", status: "session_expired" }),
      environment({ instanceId: 9, instanceName: "default" }),
      environment({ instanceId: 5, projectId: 8 }),
      environment({ instanceId: null, environmentId: "host" }),
    ],
    threads: [
      thread("env-1", "2026-11-10T10:00:00Z"),
      thread("env-1", "2026-11-11T10:00:00Z"),
      thread("env-1", "2026-11-12T10:00:00Z", "2026-11-12T11:00:00Z"),
      thread("env-2", "2026-11-09T10:00:00Z"),
    ],
    pairedEnvironmentIds: new Set(["env-2"]),
  });

  it("lists every Instance of the Project, whoever registered it, never the default", () => {
    expect(rows.map((row) => row.name)).toEqual(["fix", "login", "expired", "sleepy"]);
  });

  it("counts local threads and last use per environment, skipping archived ones", () => {
    const fix = rows.find((row) => row.name === "fix")!;
    expect(fix).toMatchObject({
      environmentId: "env-1",
      threadCount: 2,
      lastUsedAt: "2026-11-11T10:00:00Z",
      domain: "i1.nckrtl.test",
    });
    expect(orbitInstanceRowSubline(fix)).toBe("beast · i1.nckrtl.test · 2 threads");
    expect(orbitInstanceRowSubline(rows.find((row) => row.name === "login")!)).toBe(
      "beast · i2.nckrtl.test · 1 thread",
    );
  });

  it("keeps an asleep Instance pickable with its state word, and disables an expired one", () => {
    const sleepy = rows.find((row) => row.name === "sleepy")!;
    const expired = rows.find((row) => row.name === "expired")!;
    expect([sleepy.state, sleepy.disabledReason]).toEqual(["stopped", null]);
    expect(orbitInstanceRowSubline(sleepy)).toBe("beast · Stopped · i3.nckrtl.test · no threads");
    expect(orbitInstancePick(sleepy)).toMatchObject({ kind: "unpaired", instanceId: 3 });
    expect([expired.state, expired.disabledReason]).toEqual([
      "expired",
      ORBIT_INSTANCE_EXPIRED_REASON,
    ]);
    expect(orbitInstanceRowSubline(expired)).toBe(`beast · ${ORBIT_INSTANCE_EXPIRED_REASON}`);
    expect(orbitInstancePick(expired)).toEqual({ kind: "disabled" });
  });

  it("disables an asleep Instance on an older Gateway without the wake route", () => {
    const [sleepy] = buildOrbitInstanceRows({
      projectId: 3,
      environments: [environment({ instanceId: 3, instanceName: "sleepy", powerState: "stopped" })],
      threads: [],
      pairedEnvironmentIds: new Set(),
      canWake: false,
    });
    expect(sleepy!.disabledReason).toBe(ORBIT_INSTANCE_STOPPED_REASON);
    expect(orbitInstancePick(sleepy!)).toEqual({ kind: "disabled" });
  });

  it("opens a paired Instance in its clone project and an unpaired one as an Orbit draft", () => {
    expect(orbitInstancePick(rows.find((row) => row.name === "login")!)).toEqual({
      kind: "paired",
      environmentId: "env-2",
    });
    expect(orbitInstancePick(rows.find((row) => row.name === "fix")!)).toEqual({
      kind: "unpaired",
      instanceId: 1,
      environmentId: "env-1",
      name: "fix",
    });
    const projects = [
      { environmentId: "env-2", workspaceRoot: "/srv/other", id: "a" },
      { environmentId: "env-2", workspaceRoot: "/srv/workspace", id: "b" },
      { environmentId: "env-1", workspaceRoot: "/srv/workspace", id: "c" },
    ];
    expect(orbitCloneProject(projects, "env-2")?.id).toBe("b");
    expect(orbitCloneProject(projects.slice(0, 1), "env-2")?.id).toBe("a");
    expect(orbitCloneProject(projects, "env-9")).toBeNull();
  });

  it("filters by name, Node or domain", () => {
    expect(filterOrbitInstanceRows(rows, "LOG").map((row) => row.name)).toEqual(["login"]);
    expect(filterOrbitInstanceRows(rows, "i3.nckrtl").map((row) => row.name)).toEqual(["sleepy"]);
    expect(filterOrbitInstanceRows(rows, "nothing")).toEqual([]);
    expect(filterOrbitInstanceRows(rows, " ")).toHaveLength(4);
  });
});
