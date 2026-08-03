import { describe, expect, it } from "vite-plus/test";

import {
  ProviderDriverKind,
  ProviderAuthSessionId,
  ProviderInstanceId,
  type ProviderAuthSessionSnapshot,
} from "@t3tools/contracts";

import { applyProviderAuthAttachEvent, selectProviderAuthSetupCandidates } from "./providerAuth.ts";

const SESSION_ID = ProviderAuthSessionId.make("auth-1");
const SNAPSHOT: ProviderAuthSessionSnapshot = {
  sessionId: SESSION_ID,
  instanceId: ProviderInstanceId.make("codex"),
  action: "signIn",
  status: "running",
  history: "Visit ",
  exitCode: null,
  exitSignal: null,
  startedAt: "2026-08-03T00:00:00.000Z",
  finishedAt: null,
  message: null,
  sequence: 1,
};

describe("provider auth attach reducer", () => {
  it("replaces state with the authoritative snapshot", () => {
    expect(applyProviderAuthAttachEvent(null, { type: "snapshot", snapshot: SNAPSHOT })).toEqual(
      SNAPSHOT,
    );
  });

  it("appends ordered output and ignores duplicate events", () => {
    const event = {
      type: "output" as const,
      sessionId: SESSION_ID,
      sequence: 2,
      data: "https://example.test\n",
    };
    const next = applyProviderAuthAttachEvent(SNAPSHOT, event);
    expect(next).toMatchObject({
      history: "Visit https://example.test\n",
      sequence: 2,
    });
    expect(applyProviderAuthAttachEvent(next, event)).toBe(next);
  });

  it("takes the settled snapshot instead of deriving exit state", () => {
    const settled = { ...SNAPSHOT, status: "succeeded" as const, sequence: 3 };
    expect(
      applyProviderAuthAttachEvent(SNAPSHOT, {
        type: "settled",
        sessionId: SESSION_ID,
        sequence: 3,
        snapshot: settled,
      }),
    ).toEqual(settled);
  });
});

describe("provider auth setup", () => {
  it("prompts only for enabled, installed, explicitly unauthenticated providers", () => {
    const provider = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "warning" as const,
      auth: { status: "unauthenticated" as const },
      authManagement: { canSignIn: true, canSignOut: true, activeSession: null },
      checkedAt: "2026-08-03T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };

    expect(
      selectProviderAuthSetupCandidates([
        provider,
        { ...provider, instanceId: ProviderInstanceId.make("disabled"), enabled: false },
        {
          ...provider,
          instanceId: ProviderInstanceId.make("unknown"),
          auth: { status: "unknown" },
        },
      ]),
    ).toEqual([provider]);
  });
});
