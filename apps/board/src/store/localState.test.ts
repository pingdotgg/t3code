import { describe, expect, it } from "vite-plus/test";

import { createLocalState, EMPTY_LOCAL_STATE } from "./localState";

/** The file in the user data folder. */
function fakeStorage(initial = "") {
  const file = { text: initial };
  return {
    file,
    storage: {
      read: async () => file.text,
      write: async (text: string) => {
        file.text = text;
      },
    },
  };
}

describe("local state", () => {
  it("Given no file, when read, then it is empty", async () => {
    expect(await createLocalState(fakeStorage().storage).read()).toEqual(EMPTY_LOCAL_STATE);
  });

  it("Given a corrupt file, when read, then it is empty instead of failing", async () => {
    expect(await createLocalState(fakeStorage("{ nope").storage).read()).toEqual(EMPTY_LOCAL_STATE);
  });

  it("Given a last opened board, when the app reads again, then it is still there", async () => {
    const { storage } = fakeStorage();
    await createLocalState(storage).update((state) => ({
      ...state,
      lastOpenedBoard: { projectId: "p1", folder: "claude-connector" },
    }));
    expect((await createLocalState(storage).read()).lastOpenedBoard).toEqual({
      projectId: "p1",
      folder: "claude-connector",
    });
  });

  it("Given two updates at once, when both finish, then both changes are kept", async () => {
    const local = createLocalState(fakeStorage().storage);
    await Promise.all([
      local.update((state) => ({
        ...state,
        lastOpenedBoard: { projectId: "p1", folder: "a" },
      })),
      local.update((state) => ({
        ...state,
        cardPositions: { ...state.cardPositions, b1: { c1: { x: 10, y: 20 } } },
      })),
    ]);
    const state = await local.read();
    expect(state.lastOpenedBoard?.folder).toBe("a");
    expect(state.cardPositions["b1"]?.["c1"]).toEqual({ x: 10, y: 20 });
  });
});
