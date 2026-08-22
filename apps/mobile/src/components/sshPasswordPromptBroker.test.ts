import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import type { SourceControlSshPasswordPromptRequest } from "@t3tools/contracts";

import {
  createSshPasswordPromptBroker,
  type PresentedSshPasswordPromptRequest,
} from "./sshPasswordPromptBroker";

const request = (requestId: string): SourceControlSshPasswordPromptRequest => ({
  requestId,
  destination: "git@github.com:t3tools/t3code.git",
  username: null,
  prompt: "Enter the SSH key passphrase or password.",
  attempt: 1,
  expiresAt: "2026-08-17T10:00:00.000Z",
  expiresInMs: 3 * 60 * 1_000,
});

describe("mobile SSH password prompt broker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a queued prompt's original receipt time when it becomes visible", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(2_000).mockReturnValue(5_000);
    const broker = createSshPasswordPromptBroker();
    const presented: PresentedSshPasswordPromptRequest[] = [];
    broker.subscribe((current) => {
      if (current !== null) {
        presented.push(current);
      }
    });
    const firstSession = broker.createSession();
    const secondSession = broker.createSession();

    const firstPassword = firstSession.request(request("first"));
    const secondPassword = secondSession.request(request("second"));
    broker.resolveCurrent("first", "first secret");
    await firstPassword;

    expect(presented[1]?.requestId).toBe("second");
    expect(presented[1]?.receivedAtMs).toBe(2_000);
    broker.resolveCurrent("second", "second secret");
    await secondPassword;
  });

  it("queues prompts from independent operations", async () => {
    const broker = createSshPasswordPromptBroker();
    let currentRequestId: string | null = null;
    const presentedRequestIds: Array<string | null> = [];
    broker.subscribe((current) => {
      currentRequestId = current?.requestId ?? null;
      presentedRequestIds.push(currentRequestId);
    });
    const firstSession = broker.createSession();
    const secondSession = broker.createSession();

    const firstPassword = firstSession.request(request("first"));
    const secondPassword = secondSession.request(request("second"));

    expect(currentRequestId).toBe("first");
    expect(presentedRequestIds).toEqual([null, "first"]);
    broker.resolveCurrent("first", "first secret");
    await expect(firstPassword).resolves.toBe("first secret");
    expect(currentRequestId).toBe("second");
    broker.resolveCurrent("second", "second secret");
    await expect(secondPassword).resolves.toBe("second secret");
  });

  it("does not cancel a newer operation when an older operation cleans up", async () => {
    const broker = createSshPasswordPromptBroker();
    let currentRequestId: string | null = null;
    broker.subscribe((current) => {
      currentRequestId = current?.requestId ?? null;
    });
    const cloneSession = broker.createSession();
    const gitSession = broker.createSession();

    const clonePassword = cloneSession.request(request("clone"));
    broker.resolveCurrent("clone", "clone secret");
    await expect(clonePassword).resolves.toBe("clone secret");

    const gitPassword = gitSession.request(request("git"));
    cloneSession.cancel();

    expect(currentRequestId).toBe("git");
    broker.resolveCurrent("git", "git secret");
    await expect(gitPassword).resolves.toBe("git secret");
  });

  it("cancels only prompts owned by the session", async () => {
    const broker = createSshPasswordPromptBroker();
    let currentRequestId: string | null = null;
    broker.subscribe((current) => {
      currentRequestId = current?.requestId ?? null;
    });
    const firstSession = broker.createSession();
    const secondSession = broker.createSession();

    const firstPassword = firstSession.request(request("first"));
    const secondPassword = secondSession.request(request("second"));
    secondSession.cancel();

    await expect(secondPassword).resolves.toBeNull();
    expect(currentRequestId).toBe("first");
    broker.resolveCurrent("first", "first secret");
    await expect(firstPassword).resolves.toBe("first secret");
  });
});
