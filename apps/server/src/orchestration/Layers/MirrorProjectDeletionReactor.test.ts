import { ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import type { MirrorService } from "../../mirror/MirrorService.ts";
import { revokeMirrorLinkAndCredentials } from "./MirrorProjectDeletionReactor.ts";

const fakeSession = (subject: string, sessionId: string) => ({
  sessionId: sessionId as never,
  subject,
  scopes: ["mirror:sync"] as never,
  method: "bearer-access-token" as const,
  client: { deviceType: "bot" as const },
  issuedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2027-01-01T00:00:00.000Z"),
  lastConnectedAt: null,
  connected: false,
  current: false,
});

describe("revokeMirrorLinkAndCredentials", () => {
  it("revokes the mirror link and only the sessions for that project's mirror-peer subject", async () => {
    const projectId = ProjectId.make("project-to-delete");
    const otherProjectId = ProjectId.make("some-other-project");

    const revokedLinkProjectIds: string[] = [];
    const revokedSessionIds: string[] = [];

    const mirrorService = {
      revokeLink: (id: string) =>
        Effect.sync(() => {
          revokedLinkProjectIds.push(id);
        }),
    } as unknown as MirrorService["Service"];

    const serverAuth = {
      listSessions: () =>
        Effect.succeed([
          fakeSession(`mirror-peer:${projectId}`, `mirror-peer-session:${projectId}`),
          fakeSession(`mirror-peer:${otherProjectId}`, `mirror-peer-session:${otherProjectId}`),
        ]),
      revokeSession: (sessionId: string) =>
        Effect.sync(() => {
          revokedSessionIds.push(sessionId);
          return true;
        }),
    } as unknown as EnvironmentAuth["Service"];

    await Effect.runPromise(
      revokeMirrorLinkAndCredentials({ projectId, mirrorService, serverAuth }),
    );

    expect(revokedLinkProjectIds).toEqual([projectId]);
    expect(revokedSessionIds).toEqual([`mirror-peer-session:${projectId}`]);
  });

  it("is a no-op for a project that was never mirrored", async () => {
    const projectId = ProjectId.make("never-mirrored-project");
    const revokedSessionIds: string[] = [];

    const mirrorService = {
      revokeLink: () => Effect.void,
    } as unknown as MirrorService["Service"];

    const serverAuth = {
      listSessions: () => Effect.succeed([]),
      revokeSession: (sessionId: string) =>
        Effect.sync(() => {
          revokedSessionIds.push(sessionId);
          return true;
        }),
    } as unknown as EnvironmentAuth["Service"];

    await Effect.runPromise(
      revokeMirrorLinkAndCredentials({ projectId, mirrorService, serverAuth }),
    );

    expect(revokedSessionIds).toEqual([]);
  });
});
