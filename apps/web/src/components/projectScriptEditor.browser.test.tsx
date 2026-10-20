import { act, render, type Screen } from "../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  ProjectScriptEditorDialog,
  type ProjectScriptActionResult,
  type ProjectScriptEditorRequest,
} from "./projectScriptEditor";

const onSubmit = vi.fn<Parameters<typeof ProjectScriptEditorDialog>[0]["onSubmit"]>();
const onClose = vi.fn();
const onDelete = vi.fn();

function request(name: string, error?: string): ProjectScriptEditorRequest {
  return {
    scriptId: name,
    initial: { ...EMPTY_PROJECT_SCRIPT_INPUT, name, command: `run-${name}` },
    ...(error === undefined ? {} : { error }),
  };
}

const open = (screen: Screen, nextRequest: ProjectScriptEditorRequest, workspaceNoun?: string) =>
  screen.rerender(
    <StrictMode>
      <ProjectScriptEditorDialog
        environmentId={EnvironmentId.make("test")}
        {...(workspaceNoun === undefined ? {} : { workspaceNoun })}
        request={nextRequest}
        scripts={[]}
        onSubmit={onSubmit}
        onClose={onClose}
        onDelete={onDelete}
      />
    </StrictMode>,
  );

const submit = () => document.querySelector("form")!.requestSubmit();
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent === label)!;
const saveButton = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const fieldset = () => document.querySelector("fieldset")!;
const messages = () => [...document.querySelectorAll("form p")].map((p) => p.textContent);

function deferredSave() {
  let resolve!: (result: ProjectScriptActionResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ProjectScriptActionResult>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  return { promise, resolve, reject };
}

function setup() {
  onSubmit.mockReset();
  onClose.mockReset();
  onDelete.mockReset();
}

describe("project action editor save lifecycle", () => {
  it.each([
    [undefined, "worktree"],
    ["workspace", "workspace"],
  ])("saves the settle action using %s terminology", async (workspaceNoun, expectedNoun) => {
    setup();
    await using screen = await render(null);
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    await open(screen, request("build"), workspaceNoun);
    const settleLabel = [...document.querySelectorAll("label")].find(
      (label) => label.textContent === `Run in the thread's ${expectedNoun} when the thread settles`,
    );
    expect(settleLabel).toBeDefined();
    await act(async () => {
      settleLabel!.click();
    });
    await act(async () => submit());
    expect(onSubmit).toHaveBeenCalledWith(
      "build",
      expect.objectContaining({ runOnSettle: true }),
    );
  });

  it("blocks repeated submits and edits until the current save completes", async () => {
    setup();
    await using screen = await render(null);
    const save = deferredSave();
    onSubmit.mockReturnValue(save.promise);
    await open(screen, request("build"));

    await act(async () => {
      submit();
      submit();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toBe("Saving…");
    expect(fieldset().disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(false);

    await act(async () => save.resolve(AsyncResult.success(undefined)));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close a replacement request or release its in-flight save", async () => {
    setup();
    await using screen = await render(null);
    const first = deferredSave();
    const second = deferredSave();
    onSubmit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await open(screen, request("build"));
    await act(async () => submit());

    await open(screen, request("test"));
    expect(saveButton().disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#script-name")!.value).toBe("test");
    await act(async () => submit());

    await act(async () => first.resolve(AsyncResult.success(undefined)));
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);

    await act(async () => second.resolve(AsyncResult.success(undefined)));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls.map(([scriptId]) => scriptId)).toEqual(["build", "test"]);
  });

  it.each(["failure", "rejection"] as const)(
    "ignores a stale %s after the request changes",
    async (outcome) => {
      setup();
      await using screen = await render(null);
      const save = deferredSave();
      onSubmit.mockReturnValue(save.promise);
      await open(screen, request("build"));
      await act(async () => submit());

      await open(screen, request("test", "New request error"));
      await act(async () => {
        if (outcome === "failure")
          save.resolve(AsyncResult.failure(Cause.fail(new Error("Old save error"))));
        else save.reject(new Error("Old save error"));
      });

      expect(messages()).toContain("New request error");
      expect(messages()).not.toContain("Old save error");
      expect(saveButton().disabled).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it("shows a current save error and allows retry", async () => {
    setup();
    await using screen = await render(null);
    onSubmit.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Save failed"))));
    onSubmit.mockResolvedValueOnce(AsyncResult.success(undefined));
    await open(screen, request("build"));

    await act(async () => saveButton().click());
    expect(messages()).toContain("Save failed");
    expect(saveButton().disabled).toBe(false);
    expect(fieldset().disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => saveButton().click());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(["cancel", "unmount"] as const)("ignores save completion after %s", async (exit) => {
    setup();
    await using screen = await render(null);
    const save = deferredSave();
    onSubmit.mockReturnValue(save.promise);
    await open(screen, request("build"));
    await act(async () => submit());

    await act(async () => {
      if (exit === "cancel") button("Cancel").click();
      else {
        await screen.unmount();
      }
    });
    onClose.mockClear();
    await act(async () => save.resolve(AsyncResult.success(undefined)));
    expect(onClose).not.toHaveBeenCalled();
  });
});
