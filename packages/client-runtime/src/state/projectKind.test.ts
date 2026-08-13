import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  CHAT_DRAFT_PROJECT_ID,
  chatLogicalProjectKey,
  isChatDraft,
  isChatThread,
  projectHasWorkspace,
} from "./projectKind.ts";

const env = EnvironmentId.make("env-1");
const workspaceProjectId = ProjectId.make("project-1");

it("uses a stable chat draft sentinel and logical key", () => {
  expect(CHAT_DRAFT_PROJECT_ID).toBe("chat");
  expect(chatLogicalProjectKey(env)).toBe("env-1:chat");
});

it("treats missing and chat-kind projects as having no workspace", () => {
  expect(projectHasWorkspace(null)).toBe(false);
  expect(projectHasWorkspace(undefined)).toBe(false);
  expect(projectHasWorkspace({ kind: "chat" })).toBe(false);
  expect(projectHasWorkspace({ kind: "workspace" })).toBe(true);
  expect(projectHasWorkspace({})).toBe(true);
});

it("identifies chat drafts only when the scratch flag is set", () => {
  expect(isChatDraft(null)).toBe(false);
  expect(isChatDraft({})).toBe(false);
  expect(isChatDraft({ createInChatScratch: false })).toBe(false);
  expect(isChatDraft({ createInChatScratch: true })).toBe(true);
});

it("does not treat missing projects as chats until the shell is known", () => {
  const thread = { environmentId: env, projectId: ProjectId.make("hidden") };
  expect(
    isChatThread({
      thread,
      projects: [],
      projectsKnown: false,
    }),
  ).toBe(false);
  expect(
    isChatThread({
      thread,
      projects: [],
      projectsKnown: true,
    }),
  ).toBe(true);
});

it("treats threads whose project is in the visible list as workspace threads", () => {
  expect(
    isChatThread({
      thread: { environmentId: env, projectId: workspaceProjectId },
      projects: [{ environmentId: env, id: workspaceProjectId }],
      projectsKnown: true,
    }),
  ).toBe(false);
});
