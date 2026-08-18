import {
  IsoDateTime,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Dialog } from "../ui/dialog";
import { ThreadHandoffContent } from "./ThreadHandoffDialog";
import type { ProviderInstanceEntry } from "../../providerInstances";

describe("ThreadHandoffContent", () => {
  const dummyInstanceEntries: ReadonlyArray<ProviderInstanceEntry> = [
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      displayName: "Claude Code",
      driverKind: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      status: "ready",
      isAvailable: true,
      isDefault: true,
      models: [],
      snapshot: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude Code",
        enabled: true,
        installed: true,
        status: "ready",
        isDefault: true,
        models: [],
      } as any,
    },
    {
      instanceId: ProviderInstanceId.make("codex"),
      displayName: "Codex",
      driverKind: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      status: "ready",
      isAvailable: true,
      isDefault: false,
      models: [],
      snapshot: {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: "ready",
        isDefault: false,
        models: [],
      } as any,
    },
  ];

  it("renders handoff content with source and target model indicators and markdown preview", () => {
    const markup = renderToStaticMarkup(
      <Dialog open>
        <ThreadHandoffContent
          sourceThread={{
            id: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-1"),
            title: "Optimize database queries",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-3-7-sonnet",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feat/optimize-db",
            worktreePath: null,
            latestTurn: null,
            createdAt: IsoDateTime.make("2026-08-15T10:00:00.000Z"),
            updatedAt: IsoDateTime.make("2026-08-15T10:00:00.000Z"),
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            deletedAt: null,
            messages: [
              {
                id: "msg-1" as any,
                role: "user",
                text: "Add index to user_id column",
                turnId: null,
                streaming: false,
                createdAt: IsoDateTime.make("2026-08-15T10:00:00.000Z"),
                updatedAt: IsoDateTime.make("2026-08-15T10:00:00.000Z"),
              },
            ],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: null,
          }}
          targetModelSelection={{
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          }}
          providerInstanceEntries={dummyInstanceEntries}
          onConfirmHandoff={() => {}}
        />
      </Dialog>,
    );

    expect(markup).toContain("Continue in new thread");
    expect(markup).toContain("claude-3-7-sonnet");
    expect(markup).toContain("gpt-5.3-codex");
    expect(markup).toContain("Handoff context (editable)");
    expect(markup).toContain("handoff-context-textarea");
    expect(markup).toContain("Continue with gpt-5.3-codex");
    expect(markup).toContain("Add index to user_id column");
  });
});
