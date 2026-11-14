import { describe, expect, it } from "vite-plus/test";

import {
  type CustomModelSave,
  pendingCustomModelSaves,
  settleCustomModelSave,
} from "./customModelSaves.logic";

type Step =
  | { readonly send: string }
  | { readonly reply: string; readonly saved?: boolean }
  | { readonly echo: string };

/** Replays sends, replies and stored-list echoes; returns the pending saves' keys. */
function replay(initial: string, steps: ReadonlyArray<Step>) {
  let stored = initial;
  let saves: ReadonlyArray<CustomModelSave> = [];
  const sent: Array<CustomModelSave> = [];
  for (const step of steps) {
    if ("send" in step) {
      const save: CustomModelSave = { models: [], key: step.send };
      sent.push(save);
      saves = saves.concat(save);
    } else if ("reply" in step) {
      const save = sent.find((entry) => entry.key === step.reply)!;
      sent.splice(sent.indexOf(save), 1);
      saves = settleCustomModelSave(saves, save, step.saved ?? true);
    } else if (step.echo !== stored) {
      stored = step.echo;
      saves = pendingCustomModelSaves(saves, stored);
    }
  }
  return saves.map((entry) => entry.key);
}

describe("pending custom model saves", () => {
  it.each<[string, ReadonlyArray<Step>, ReadonlyArray<string>]>([
    [
      "an echo settles its save, not a later one",
      [{ send: "a" }, { send: "ab" }, { echo: "a" }],
      ["ab"],
    ],
    [
      "a reply before the echo keeps the save",
      [{ send: "a" }, { reply: "a" }, { send: "ab" }, { echo: "a" }],
      ["ab"],
    ],
    ["a failed save is dropped", [{ send: "a" }, { reply: "a", saved: false }], []],
    [
      "a coalesced repeated snapshot settles every save, so a later external match is not an echo",
      [
        { send: "a" },
        { reply: "a" },
        { send: "b" },
        { reply: "b" },
        { send: "a" },
        { reply: "a" },
        { echo: "a" },
        { echo: "b" },
      ],
      [],
    ],
    [
      "a save racing an external change is dropped on reply",
      [{ send: "a" }, { echo: "x" }, { reply: "a" }],
      [],
    ],
    [
      "a rename then restore survives both echoes",
      [
        { send: "a" },
        { reply: "a" },
        { send: "0" },
        { reply: "0" },
        { send: "b" },
        { echo: "a" },
        { echo: "0" },
      ],
      ["b"],
    ],
    [
      "an external change drops replied saves but keeps in-flight ones",
      [{ send: "a" }, { reply: "a" }, { send: "ab" }, { echo: "x" }],
      ["ab"],
    ],
    [
      "a late reply after the echo leaves nothing pending",
      [
        { send: "a" },
        { send: "ab" },
        { echo: "ab" },
        { echo: "a" },
        { reply: "a" },
        { reply: "ab" },
      ],
      [],
    ],
  ])("%s", (_name, steps, pending) => {
    expect(replay("0", steps)).toEqual(pending);
  });
});
