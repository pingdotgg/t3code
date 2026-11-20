import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createLocalStateFile } from "./localState";

const folders: string[] = [];
const userData = () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "board-local-state-"));
  folders.push(folder);
  return NodePath.join(folder, "nested", "local-state.json");
};

afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

describe("local state file", () => {
  it("Given no file yet, when read, then it is empty", () => {
    expect(createLocalStateFile(userData()).read()).toBe("");
  });

  it("Given text written, when a new reader opens the same file, then it reads the same text", () => {
    const file = userData();
    createLocalStateFile(file).write('{"lastOpenedBoard":null}');
    expect(createLocalStateFile(file).read()).toBe('{"lastOpenedBoard":null}');
  });

  it("Given two writes, when read, then the last one wins and no temp file is left", () => {
    const file = userData();
    const state = createLocalStateFile(file);
    state.write("first");
    state.write("second");
    expect(state.read()).toBe("second");
    expect(NodeFS.readdirSync(NodePath.dirname(file))).toEqual(["local-state.json"]);
  });
});
