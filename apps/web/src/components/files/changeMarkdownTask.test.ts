import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { readAtom, optimisticAtom } = await vi.hoisted(async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  return {
    readAtom: Atom.make<AsyncResult.AsyncResult<ProjectReadFileResult, never>>(
      AsyncResult.initial(false),
    ),
    optimisticAtom: Atom.make<{
      data: ProjectReadFileResult;
      confirmedAgainst: unknown;
    } | null>(null),
  };
});
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    readFile: () => readAtom,
    optimisticFile: () => optimisticAtom,
  },
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { changeMarkdownTask } from "./changeMarkdownTask";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { setProjectFileQueryData } from "./projectFilesQueryState";

const identity = {
  environmentId: EnvironmentId.make("markdown-authority-test"),
  cwd: "/disposable-workspace",
  relativePath: "README.md",
};

function read(contents: string, truncated = false) {
  appAtomRegistry.set(
    readAtom,
    AsyncResult.success({ ...identity, contents, truncated, byteLength: contents.length }),
  );
}

function fixture(contents: string, readOnly = false) {
  let persisted = contents;
  let displayed = contents;
  const persist = vi.fn(async (next: string) => {
    persisted = next;
    return AsyncResult.success(undefined);
  });
  const coordinator = new FileSaveCoordinator({
    debounceMs: 500,
    persist,
    onPendingChange: vi.fn(),
    onConfirmed: vi.fn(),
  });
  return {
    render: (next: string) => {
      displayed = next;
    },
    toggle: (markerOffset = 2, checked = true) =>
      changeMarkdownTask({
        ...identity,
        readOnly,
        contents: displayed,
        markerOffset,
        checked,
        change: (next) => coordinator.change(next),
      }),
    persisted: () => persisted,
    persist,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  appAtomRegistry.set(readAtom, AsyncResult.initial(false));
  appAtomRegistry.set(optimisticAtom, null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("rendered Markdown write authority", () => {
  it("preserves the whole file when the visible prefix is truncated", async () => {
    const wholeFile = "- [ ] task\n" + "a".repeat(1024 * 1024) + "\nTAIL\n";
    read(wholeFile.slice(0, 1024 * 1024), true);
    const file = fixture(wholeFile);
    file.toggle();
    await vi.runAllTimersAsync();
    expect(file.persist).not.toHaveBeenCalled();
    expect(file.persisted()).toBe(wholeFile);
    expect(appAtomRegistry.get(optimisticAtom)).toBeNull();
  });

  it("rechecks a truncated refresh after a writable callback was created", async () => {
    const original = "- [ ] task\noriginal tail\n";
    read(original);
    const file = fixture(original);
    setProjectFileQueryData(identity.environmentId, identity.cwd, identity.relativePath, original);
    read("- [ ] task\n", true);
    file.toggle();
    await vi.runAllTimersAsync();
    expect(file.persist).not.toHaveBeenCalled();
    expect(file.persisted()).toBe(original);
    expect(appAtomRegistry.get(optimisticAtom)?.data.contents).toBe(original);
  });

  it("does not replace a complete read-only host file", async () => {
    const original = "- [ ] host task\n";
    read(original);
    const file = fixture(original, true);
    file.toggle();
    await vi.runAllTimersAsync();
    expect(file.persist).not.toHaveBeenCalled();
    expect(file.persisted()).toBe(original);
    expect(appAtomRegistry.get(optimisticAtom)).toBeNull();
  });

  it("preserves other characters and accumulates edits from the latest displayed draft", async () => {
    const original = "- [ ] first\r\n- [X] second\r\n尾\r\n";
    read(original);
    const file = fixture(original);
    file.toggle();
    file.render("- [x] first\r\n- [X] second\r\n尾\r\n");
    file.toggle(original.indexOf("[X]"), false);
    await vi.runAllTimersAsync();
    expect(file.persist).toHaveBeenCalledExactlyOnceWith("- [x] first\r\n- [ ] second\r\n尾\r\n");
    expect(file.persisted()).toBe("- [x] first\r\n- [ ] second\r\n尾\r\n");
  });

  it("does not authorize a write when the live read is unavailable", async () => {
    const file = fixture("- [ ] task\n");
    file.toggle();
    await vi.runAllTimersAsync();
    expect(file.persist).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(optimisticAtom)).toBeNull();
  });

  it("does not authorize an optimistic draft without a live read", async () => {
    const original = "- [ ] task\n";
    const file = fixture(original);
    setProjectFileQueryData(identity.environmentId, identity.cwd, identity.relativePath, original);
    file.toggle();
    await vi.runAllTimersAsync();
    expect(file.persist).not.toHaveBeenCalled();
    expect(file.persisted()).toBe(original);
    expect(appAtomRegistry.get(optimisticAtom)?.data.contents).toBe(original);
  });

  it("does not write a retained success after a failed refresh", async () => {
    const original = "- [ ] task\n";
    read(original);
    const previous = appAtomRegistry.get(readAtom);
    appAtomRegistry.set(
      readAtom,
      AsyncResult.failureWithPrevious(Cause.die(new Error("read failed")), {
        previous: Option.some(previous),
      }),
    );
    const file = fixture(original);
    file.toggle();
    await vi.runAllTimersAsync();
    expect(file.persist).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(optimisticAtom)).toBeNull();
  });

  it("waits for a pending refresh before authorizing another edit", async () => {
    const original = "- [ ] task\n";
    appAtomRegistry.set(
      readAtom,
      AsyncResult.success(
        { ...identity, contents: original, truncated: false, byteLength: original.length },
        { waiting: true },
      ),
    );
    const file = fixture(original);
    file.toggle();
    await vi.runAllTimersAsync();
    expect(file.persist).not.toHaveBeenCalled();
    read(original);
    file.toggle();
    await vi.runAllTimersAsync();
    expect(file.persist).toHaveBeenCalledExactlyOnceWith("- [x] task\n");
  });

  it("does not apply a displayed task offset to a different complete snapshot", async () => {
    const original = "- [ ] intended task\n";
    read(original);
    const file = fixture(original);
    read("- [ ] replacement task\n");
    file.toggle();
    await vi.runAllTimersAsync();
    expect(file.persist).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(optimisticAtom)).toBeNull();
    file.render("- [ ] replacement task\n");
    file.toggle();
    await vi.runAllTimersAsync();
    expect(file.persist).toHaveBeenCalledExactlyOnceWith("- [x] replacement task\n");
  });

  it("does not save an invalid marker offset", async () => {
    read("- [ ] task\n");
    const file = fixture("- [ ] task\n");
    file.toggle(0);
    await vi.runAllTimersAsync();
    expect(file.persist).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(optimisticAtom)).toBeNull();
  });
});
