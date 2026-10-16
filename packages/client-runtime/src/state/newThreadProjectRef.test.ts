import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ProjectSettingsOverrides } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveNewThreadProjectRef } from "./projectGrouping.ts";

const mac = { environmentId: EnvironmentId.make("mac"), id: ProjectId.make("mac-project") };
const pad = { environmentId: EnvironmentId.make("pad"), id: ProjectId.make("pad-project") };
const macRef = { environmentId: mac.environmentId, projectId: mac.id };
const padRef = { environmentId: pad.environmentId, projectId: pad.id };
const connectedEnvironmentIds = new Set([mac.environmentId, pad.environmentId]);

function settings(
  macOverride: ProjectSettingsOverrides = {},
  padOverride: ProjectSettingsOverrides = {},
) {
  return new Map([
    [mac.environmentId, { projectSettingsOverrides: { [mac.id]: macOverride } }],
    [pad.environmentId, { projectSettingsOverrides: { [pad.id]: padOverride } }],
  ]);
}

const input = {
  members: [mac, pad],
  settingsByEnvironment: settings({ defaultEnvironmentId: pad.environmentId }),
  connectedEnvironmentIds,
  contextProjectRef: macRef,
  primaryEnvironmentId: mac.environmentId,
};

describe("new thread project environment", () => {
  it("uses the connected project default ahead of the active thread and primary environment", () => {
    expect(resolveNewThreadProjectRef(input)).toEqual({
      projectRef: padRef,
      environmentSelection: "project-default",
    });
  });

  it("keeps an explicit environment or checkout ahead of the project default", () => {
    expect(resolveNewThreadProjectRef({ ...input, manualProjectRef: macRef })).toEqual({
      projectRef: macRef,
      environmentSelection: "manual",
    });
  });

  it.each([
    ["missing a project copy", { members: [mac] }],
    [
      "disconnected along with the context",
      { contextProjectRef: padRef, connectedEnvironmentIds: new Set([mac.environmentId]) },
    ],
  ] as const)("falls back to a connected copy when the default is %s", (_reason, overrides) => {
    expect(resolveNewThreadProjectRef({ ...input, ...overrides })).toEqual({
      projectRef: macRef,
      environmentSelection: "auto",
    });
  });

  it.each([{}, { defaultEnvironmentId: null }])(
    "keeps a connected context for Automatic %j",
    (override) => {
      expect(
        resolveNewThreadProjectRef({
          ...input,
          settingsByEnvironment: settings(override),
          contextProjectRef: padRef,
        }),
      ).toEqual({ projectRef: padRef, environmentSelection: "auto" });
    },
  );

  it.each([
    [{ contextProjectRef: { ...padRef, projectId: ProjectId.make("other") } }, padRef],
    [{ contextProjectRef: null, primaryEnvironmentId: pad.environmentId }, padRef],
    [{ contextProjectRef: null, primaryEnvironmentId: null }, macRef],
  ] as const)(
    "Automatic falls back to the context machine, primary, then first member (%#)",
    (overrides, projectRef) => {
      expect(
        resolveNewThreadProjectRef({
          ...input,
          settingsByEnvironment: settings(),
          ...overrides,
        }),
      ).toEqual({ projectRef, environmentSelection: "auto" });
    },
  );

  it.each([{}, { defaultEnvironmentId: null }])(
    "prefers a connected copy over an offline context for Automatic %j",
    (override) => {
      expect(
        resolveNewThreadProjectRef({
          ...input,
          settingsByEnvironment: settings(override),
          contextProjectRef: padRef,
          connectedEnvironmentIds: new Set([mac.environmentId]),
        }),
      ).toEqual({ projectRef: macRef, environmentSelection: "auto" });
    },
  );

  it("keeps a manual offline pick ahead of connected copies", () => {
    expect(
      resolveNewThreadProjectRef({
        ...input,
        manualProjectRef: padRef,
        connectedEnvironmentIds: new Set([mac.environmentId]),
      }),
    ).toEqual({ projectRef: padRef, environmentSelection: "manual" });
  });

  it("uses the first connected copy when context and primary are offline", () => {
    const server = { environmentId: EnvironmentId.make("server"), id: ProjectId.make("server") };
    expect(
      resolveNewThreadProjectRef({
        ...input,
        settingsByEnvironment: settings(),
        members: [mac, pad, server],
        contextProjectRef: padRef,
        connectedEnvironmentIds: new Set([server.environmentId]),
      }).projectRef,
    ).toEqual({ environmentId: server.environmentId, projectId: server.id });
  });

  it.each([
    [{ contextProjectRef: padRef }, padRef],
    [{ contextProjectRef: null, primaryEnvironmentId: pad.environmentId }, padRef],
    [{ contextProjectRef: null, primaryEnvironmentId: null }, macRef],
  ] as const)(
    "keeps context, primary, then member order when nothing is connected (%#)",
    (overrides, projectRef) => {
      expect(
        resolveNewThreadProjectRef({
          ...input,
          settingsByEnvironment: settings(),
          connectedEnvironmentIds: new Set<EnvironmentId>(),
          ...overrides,
        }).projectRef,
      ).toEqual(projectRef);
    },
  );

  it.each([mac.environmentId, null])(
    "ignores a disconnected first copy's stale default %j when a connected copy has a value",
    (staleDefault) => {
      expect(
        resolveNewThreadProjectRef({
          ...input,
          connectedEnvironmentIds: new Set([pad.environmentId]),
          settingsByEnvironment: settings(
            { defaultEnvironmentId: staleDefault },
            { defaultEnvironmentId: pad.environmentId },
          ),
        }),
      ).toEqual({
        projectRef: padRef,
        environmentSelection: "project-default",
      });
    },
  );

  it("retains the context checkout when it already lives on the default environment", () => {
    const checkout = { environmentId: pad.environmentId, id: ProjectId.make("pad-checkout") };
    const checkoutRef = { environmentId: checkout.environmentId, projectId: checkout.id };
    expect(
      resolveNewThreadProjectRef({
        ...input,
        members: [mac, pad, checkout],
        contextProjectRef: checkoutRef,
      }).projectRef,
    ).toEqual(checkoutRef);
  });
});
