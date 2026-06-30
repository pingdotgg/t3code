import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { BoardId, EnvironmentId, ProjectId, type BoardListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyBoardList,
  emptyBoardListState,
  selectBoardsForProject,
  type BoardListState,
} from "./boardListState";

const projectId = ProjectId.make("project-board-list");
const otherProjectId = ProjectId.make("project-other");
const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");
const localProjectRef = scopeProjectRef(localEnvironmentId, projectId);
const remoteProjectRef = scopeProjectRef(remoteEnvironmentId, projectId);
const otherProjectRef = scopeProjectRef(localEnvironmentId, otherProjectId);

const entry = (slug: string, name: string): BoardListEntry => ({
  boardId: BoardId.make(`${projectId}__${slug}`),
  name,
  filePath: `.t3/boards/${slug}.json`,
  error: null,
});

const makeState = (): BoardListState => emptyBoardListState;

describe("board list store slice", () => {
  it("stores, selects, and replaces project board entries", () => {
    const first = [entry("delivery", "Delivery")];
    const second = [entry("triage", "Triage")];
    const empty = makeState();

    expect(selectBoardsForProject(empty, localProjectRef)).toEqual([]);

    const withBoards = applyBoardList(empty, localProjectRef, first);
    expect(selectBoardsForProject(withBoards, localProjectRef)).toEqual(first);
    expect(selectBoardsForProject(withBoards, otherProjectRef)).toEqual([]);

    const replaced = applyBoardList(withBoards, localProjectRef, second);
    expect(selectBoardsForProject(replaced, localProjectRef)).toEqual(second);
  });

  it("keeps board lists isolated for environments sharing a project id", () => {
    const localBoards = [entry("local", "Local")];
    const remoteBoards = [entry("remote", "Remote")];
    const withLocalBoards = applyBoardList(makeState(), localProjectRef, localBoards);
    const withBothBoards = applyBoardList(withLocalBoards, remoteProjectRef, remoteBoards);

    expect(selectBoardsForProject(withBothBoards, localProjectRef)).toEqual(localBoards);
    expect(selectBoardsForProject(withBothBoards, remoteProjectRef)).toEqual(remoteBoards);
  });
});
