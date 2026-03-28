import { describe, expect, it, vi } from "vitest";

import {
  getDefaultTeroHomePath,
  normalizeEnvAliases,
  TERO_DEV_HOME_DIRNAME,
  TERO_DEV_RUNNER_ENV_ALIASES,
  TERO_HOME_DIRNAME,
  TERO_RUNTIME_ENV_ALIASES,
} from "./runtime";

describe("getDefaultTeroHomePath", () => {
  it("returns the production runtime home path", () => {
    expect(getDefaultTeroHomePath("production", "/Users/tester")).toBe(
      `/Users/tester/${TERO_HOME_DIRNAME}`,
    );
  });

  it("returns the development runtime home path", () => {
    expect(getDefaultTeroHomePath("development", "/Users/tester")).toBe(
      `/Users/tester/${TERO_DEV_HOME_DIRNAME}`,
    );
  });
});

describe("normalizeEnvAliases", () => {
  it("copies legacy values into preferred keys when needed", () => {
    const env = {
      T3CODE_HOME: "/tmp/legacy",
    } as NodeJS.ProcessEnv;

    normalizeEnvAliases(TERO_RUNTIME_ENV_ALIASES, { env });

    expect(env.TERO_HOME).toBe("/tmp/legacy");
  });

  it("preserves preferred values when both keys exist", () => {
    const env = {
      TERO_HOME: "/tmp/preferred",
      T3CODE_HOME: "/tmp/legacy",
    } as NodeJS.ProcessEnv;

    normalizeEnvAliases(TERO_RUNTIME_ENV_ALIASES, { env });

    expect(env.TERO_HOME).toBe("/tmp/preferred");
  });

  it("reports conflicting non-empty values", () => {
    const env = {
      TERO_HOME: "/tmp/preferred",
      T3CODE_HOME: "/tmp/legacy",
    } as NodeJS.ProcessEnv;
    const onConflict = vi.fn();

    normalizeEnvAliases(TERO_RUNTIME_ENV_ALIASES, { env, onConflict });

    expect(onConflict).toHaveBeenCalledWith({
      preferred: "TERO_HOME",
      legacy: "T3CODE_HOME",
    });
  });

  it("covers the extra dev-runner compatibility aliases", () => {
    const env = {
      T3CODE_DEV_INSTANCE: "branch-a",
      T3CODE_DESKTOP_WS_URL: "ws://localhost:4000",
    } as NodeJS.ProcessEnv;

    normalizeEnvAliases(TERO_DEV_RUNNER_ENV_ALIASES, { env });

    expect(env.TERO_DEV_INSTANCE).toBe("branch-a");
    expect(env.TERO_DESKTOP_WS_URL).toBe("ws://localhost:4000");
  });
});
