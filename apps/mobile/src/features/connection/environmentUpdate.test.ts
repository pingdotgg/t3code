import { describe, expect, it } from "@effect/vitest";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { updateConnectionEnvironment } from "./environmentUpdate";

const environmentId = EnvironmentId.make("studio");
const relay = new RelayConnectionTarget({ environmentId, label: "Studio" });
const bearer = new BearerConnectionTarget({
  environmentId,
  label: "My Mac",
  connectionId: "direct",
});
const relayEntry: ConnectionCatalogEntry = { target: relay, profile: Option.none(), enabled: true };

function harness() {
  const settingsByEnvironment = new Map<EnvironmentId, string>();
  const aliasesByEnvironment = new Map<EnvironmentId, { label: string; url: string }>();
  let failure: string | null = null;
  const commands = {
    updateHost: async (target: {
      environmentId: EnvironmentId;
      input: { patch: { environmentLabel: string } };
    }) => {
      if (failure !== null) return { status: "failure" as const, message: failure };
      settingsByEnvironment.set(target.environmentId, target.input.patch.environmentLabel);
      return { status: "success" as const };
    },
    updateBearer: async (input: {
      environmentId: EnvironmentId;
      label: string;
      httpBaseUrl: string;
    }) => {
      aliasesByEnvironment.set(input.environmentId, { label: input.label, url: input.httpBaseUrl });
      return { status: "success" as const };
    },
  };
  return {
    commands,
    settingsByEnvironment,
    aliasesByEnvironment,
    fail: (message: string) => {
      failure = message;
    },
  };
}

describe("editing an environment connection", () => {
  it("renames and clears the chosen Connect host without changing its local routes", async () => {
    const h = harness();
    h.aliasesByEnvironment.set(environmentId, { label: "My Mac", url: "http://studio.test" });
    h.settingsByEnvironment.set(EnvironmentId.make("other"), "Other host");
    await updateConnectionEnvironment(
      relayEntry,
      environmentId,
      { label: "  Studio Mac  ", displayUrl: "ignored" },
      h.commands,
    );
    expect(h.settingsByEnvironment.get(environmentId)).toBe("Studio Mac");
    expect(h.settingsByEnvironment.get(EnvironmentId.make("other"))).toBe("Other host");
    expect(h.aliasesByEnvironment.get(environmentId)).toEqual({
      label: "My Mac",
      url: "http://studio.test",
    });
    await updateConnectionEnvironment(
      relayEntry,
      environmentId,
      { label: "  ", displayUrl: "" },
      h.commands,
    );
    expect(h.settingsByEnvironment.get(environmentId)).toBe("");
  });

  it("keeps a manual alias local even when the environment also has a relay route", async () => {
    const h = harness();
    h.settingsByEnvironment.set(environmentId, "Shared host");
    const entry = {
      ...relayEntry,
      target: bearer,
      alternateRoutes: [
        { target: bearer, profile: Option.none() },
        { target: relay, profile: Option.none() },
      ],
    };
    await updateConnectionEnvironment(
      entry,
      environmentId,
      { label: "Travel Mac", displayUrl: "http://travel.test" },
      h.commands,
    );
    expect(h.aliasesByEnvironment.get(environmentId)).toEqual({
      label: "Travel Mac",
      url: "http://travel.test",
    });
    expect(h.settingsByEnvironment.get(environmentId)).toBe("Shared host");
  });

  it("returns a denied remote update without falling back to a local alias edit", async () => {
    const h = harness();
    h.settingsByEnvironment.set(environmentId, "Studio");
    h.fail("Missing settings permission");
    expect(
      await updateConnectionEnvironment(
        relayEntry,
        environmentId,
        { label: "New name", displayUrl: "http://studio.test" },
        h.commands,
      ),
    ).toEqual({ status: "failure", message: "Missing settings permission" });
    expect(h.settingsByEnvironment.get(environmentId)).toBe("Studio");
    expect(h.aliasesByEnvironment.size).toBe(0);
  });
});
