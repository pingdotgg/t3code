import { describe, expect, it } from "vitest";
import { RemoteHostId } from "@t3tools/contracts";

import {
  doesRemoteHostDraftMatchRecord,
  draftFromRemoteHost,
  emptyRemoteHostDraft,
  formatRemoteHostSummary,
  remoteHostDraftToUpsertInput,
} from "./Sidebar.remoteHosts";

describe("Sidebar remote host helpers", () => {
  it("builds a draft from a saved host", () => {
    const host = {
      id: RemoteHostId.makeUnsafe("host-1"),
      label: "Review Host",
      host: "198.51.100.24",
      port: 22,
      user: "devuser",
      identityFile: undefined,
      sshConfigHost: undefined,
      helperCommand: "t3 remote-agent --stdio",
      helperVersion: null,
      lastConnectionAttemptAt: null,
      lastConnectionSucceededAt: null,
      lastConnectionFailedAt: null,
      lastConnectionStatus: "unknown" as const,
      lastConnectionError: null,
    };

    expect(draftFromRemoteHost(host)).toEqual({
      id: host.id,
      label: "Review Host",
      host: "198.51.100.24",
      port: "22",
      user: "devuser",
      identityFile: "",
      sshConfigHost: "",
      helperCommand: "t3 remote-agent --stdio",
    });
  });

  it("matches drafts and hosts after trimming optional fields", () => {
    const host = {
      id: RemoteHostId.makeUnsafe("host-2"),
      label: "Review Host",
      host: "203.0.113.12",
      port: 2222,
      user: "reviewer",
      identityFile: "/home/example/.ssh/review_key",
      sshConfigHost: "review-host-alias",
      helperCommand: "custom-helper --stdio",
      helperVersion: null,
      lastConnectionAttemptAt: null,
      lastConnectionSucceededAt: null,
      lastConnectionFailedAt: null,
      lastConnectionStatus: "unknown" as const,
      lastConnectionError: null,
    };

    expect(
      doesRemoteHostDraftMatchRecord(
        {
          id: host.id,
          label: " Review Host ",
          host: " 203.0.113.12 ",
          port: "2222",
          user: " reviewer ",
          identityFile: " /home/example/.ssh/review_key ",
          sshConfigHost: " review-host-alias ",
          helperCommand: " custom-helper --stdio ",
        },
        host,
      ),
    ).toBe(true);
  });

  it("normalizes a draft into an upsert payload", () => {
    const draft = emptyRemoteHostDraft();
    draft.id = RemoteHostId.makeUnsafe("host-3");
    draft.label = " Review Host ";
    draft.host = " 198.51.100.77 ";
    draft.port = "2222";
    draft.user = " devuser ";
    draft.identityFile = " /home/example/.ssh/test_key ";
    draft.sshConfigHost = " review-host ";
    draft.helperCommand = " custom-helper --stdio ";

    expect(remoteHostDraftToUpsertInput(draft)).toEqual({
      id: draft.id,
      label: "Review Host",
      host: "198.51.100.77",
      port: 2222,
      user: "devuser",
      identityFile: "/home/example/.ssh/test_key",
      sshConfigHost: "review-host",
      helperCommand: "custom-helper --stdio",
    });
  });

  it("formats host summaries without exposing implementation details", () => {
    expect(
      formatRemoteHostSummary({
        id: RemoteHostId.makeUnsafe("host-4"),
        label: "Review Host",
        host: "198.51.100.88",
        port: 2222,
        user: "devuser",
        identityFile: undefined,
        sshConfigHost: undefined,
        helperCommand: "t3 remote-agent --stdio",
        helperVersion: null,
        lastConnectionAttemptAt: null,
        lastConnectionSucceededAt: null,
        lastConnectionFailedAt: null,
        lastConnectionStatus: "unknown",
        lastConnectionError: null,
      }),
    ).toBe("devuser@198.51.100.88:2222");
  });
});
