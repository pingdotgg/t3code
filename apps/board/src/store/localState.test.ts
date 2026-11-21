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

  it("Given a file saved before frames could move, when read, then the last board is kept and no frame is moved", async () => {
    const saved = JSON.stringify({
      lastOpenedBoard: { projectId: "p1", folder: "a" },
      cardPositions: {},
    });
    expect(await createLocalState(fakeStorage(saved).storage).read()).toEqual({
      ...EMPTY_LOCAL_STATE,
      lastOpenedBoard: { projectId: "p1", folder: "a" },
    });
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

  it("Given a saved file with one custom template, when read, then the template decodes to its literal value", async () => {
    const saved = JSON.stringify({
      lastOpenedBoard: null,
      reviewTemplates: [
        {
          name: "Security only",
          authorChecks: ["simplify"],
          lanes: [{ skill: "security-audit", runsWhen: "on every ticket" }],
        },
      ],
    });
    expect((await createLocalState(fakeStorage(saved).storage).read()).reviewTemplates).toEqual([
      {
        name: "Security only",
        authorChecks: ["simplify"],
        lanes: [{ skill: "security-audit", runsWhen: "on every ticket" }],
      },
    ]);
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
        frameOrder: { ...state.frameOrder, b1: { building: ["T-2", "T-1"] } },
      })),
    ]);
    const state = await local.read();
    expect(state.lastOpenedBoard?.folder).toBe("a");
    expect(state.frameOrder["b1"]?.["building"]).toEqual(["T-2", "T-1"]);
  });
});
