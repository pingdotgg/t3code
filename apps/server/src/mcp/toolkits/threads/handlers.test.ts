import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";

import { threadsListItems } from "./handlers.ts";

const projectId = ProjectId.make("project-a");

const makeThread = (
  id: string,
  updatedAt: string,
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] => ({
  id: ThreadId.make(id),
  projectId,
  title: id,
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  createdAt: updatedAt,
  updatedAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestTurn: null,
  messages: [],
  session: null,
  activities: [],
  proposedPlans: [],
  checkpoints: [],
  deletedAt: null,
  ...overrides,
});

describe("threadsListItems", () => {
  it("orders by parsed instant so offset-bearing timestamps sort correctly", () => {
    // Lexically "10:00+02:00" > "09:30Z", but 09:30Z is the later instant
    // (10:00+02:00 = 08:00Z).
    const items = threadsListItems(
      [
        makeThread("offset", "2026-08-24T10:00:00+02:00"),
        makeThread("later", "2026-08-24T09:30:00.000Z"),
      ],
      { filter: "recent" },
    );
    expect(items.map((item) => item.threadId)).toEqual([
      ThreadId.make("later"),
      ThreadId.make("offset"),
    ]);
  });

  it("excludes deleted and archived threads", () => {
    const items = threadsListItems(
      [
        makeThread("live", "2026-08-24T10:00:00.000Z"),
        makeThread("deleted", "2026-08-24T11:00:00.000Z", {
          deletedAt: "2026-08-24T12:00:00.000Z",
        }),
        makeThread("archived", "2026-08-24T12:00:00.000Z", {
          archivedAt: "2026-08-24T13:00:00.000Z",
        }),
      ],
      { filter: "recent" },
    );
    expect(items.map((item) => item.threadId)).toEqual([ThreadId.make("live")]);
  });
});
