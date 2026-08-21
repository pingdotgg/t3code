import { ProjectId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { MirrorService } from "../../mirror/MirrorService.ts";
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
  it.effect(
    "revokes the mirror link and only the sessions for that project's mirror-peer subject",
    () =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("project-to-delete");
        const otherProjectId = ProjectId.make("some-other-project");

        const revokedLinkProjectIds: string[] = [];
        const revokedSessionIds: string[] = [];

        const layer = Layer.mergeAll(
          Layer.mock(MirrorService, {
            revokeLink: (id) =>
              Effect.sync(() => {
                revokedLinkProjectIds.push(id);
              }),
          }),
          Layer.mock(EnvironmentAuth, {
            listSessions: () =>
              Effect.succeed([
                fakeSession(`mirror-peer:${projectId}`, `mirror-peer-session:${projectId}`),
                fakeSession(
                  `mirror-peer:${otherProjectId}`,
                  `mirror-peer-session:${otherProjectId}`,
                ),
              ]),
            revokeSession: (sessionId) =>
              Effect.sync(() => {
                revokedSessionIds.push(sessionId);
                return true;
              }),
          }),
        );

        yield* revokeMirrorLinkAndCredentials(projectId).pipe(Effect.provide(layer));

        expect(revokedLinkProjectIds).toEqual([projectId]);
        expect(revokedSessionIds).toEqual([`mirror-peer-session:${projectId}`]);
      }),
  );

  it.effect("is a no-op for a project that was never mirrored", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("never-mirrored-project");
      const revokedSessionIds: string[] = [];

      const layer = Layer.mergeAll(
        Layer.mock(MirrorService, {
          revokeLink: () => Effect.void,
        }),
        Layer.mock(EnvironmentAuth, {
          listSessions: () => Effect.succeed([]),
          revokeSession: (sessionId) =>
            Effect.sync(() => {
              revokedSessionIds.push(sessionId);
              return true;
            }),
        }),
      );

      yield* revokeMirrorLinkAndCredentials(projectId).pipe(Effect.provide(layer));

      expect(revokedSessionIds).toEqual([]);
    }),
  );
});
