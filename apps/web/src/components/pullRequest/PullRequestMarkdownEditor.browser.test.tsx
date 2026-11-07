import { act, render, type Screen } from "../../../test/render";
import { AuthSourceControlWriteScope, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const permissions = vi.hoisted(() => ({
  allowed: new Set<string>(),
  listeners: new Set<() => void>(),
}));

vi.mock(import("~/state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const canWrite = (environmentId: string | null, scope: string) =>
    scope === AuthSourceControlWriteScope && permissions.allowed.has(environmentId ?? "");
  return {
    ...(await original()),
    readEnvironmentScope: canWrite,
    useEnvironmentScope: (environmentId, scope) =>
      useSyncExternalStore(
        (listener) => {
          permissions.listeners.add(listener);
          return () => permissions.listeners.delete(listener);
        },
        () => canWrite(environmentId, scope),
      ),
  };
});

vi.mock(import("~/state/pullRequests"), async (original) => ({
  ...(await original()),
  usePullRequestFilterOptions: (targets: ReadonlyArray<unknown>) => ({
    labels: [],
    authors:
      targets.length === 0
        ? []
        : [
            { login: "julius", name: "Julius", avatarUrl: null },
            { login: "theo", name: "Theo", avatarUrl: null },
          ],
    references:
      targets.length === 0
        ? []
        : [
            { reference: "#12", kind: "issue", number: 12, title: "Crash", state: "open" },
            { reference: "!12", kind: "change-request", number: 12, title: "Fix", state: "open" },
          ],
    error: null,
    isPending: false,
  }),
}));

import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";

const secondary = EnvironmentId.make("secondary");
const onSave = vi.fn<(next: string) => void>();
const onCancel = vi.fn<() => void>();

function setup() {
  permissions.allowed.clear();
  permissions.listeners.clear();
  onSave.mockReset();
  onCancel.mockReset();
}

async function openEditor(options?: { value?: string; allowEmpty?: boolean }) {
  return render(
    <PullRequestMarkdownEditor
      value={options?.value ?? "Original description"}
      cwd="/repo"
      environmentId={secondary}
      completionScope={{
        environmentId: secondary,
        projectId: ProjectId.make("project"),
        support: { mentions: true, referenceSigils: ["#", "!"] },
      }}
      label="Pull request description"
      saving={false}
      allowEmpty={options?.allowEmpty ?? false}
      onSave={onSave}
      onCancel={onCancel}
    />,
  );
}

function button(screen: Screen, label: string) {
  const match = [...screen.container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  expect(match, `button ${label}`).toBeDefined();
  return match!;
}

const clickSave = (screen: Screen) => act(async () => button(screen, "Save").click());

async function grant(allowed: boolean) {
  await act(async () => {
    if (allowed) permissions.allowed.add(secondary);
    else permissions.allowed.delete(secondary);
    permissions.listeners.forEach((listener) => listener());
  });
}

it("keeps an edited draft through revocation and saves it after access returns without remounting", async () => {
  setup();
  permissions.allowed.add(secondary);
  await using screen = await openEditor();
  const textarea = screen.container.querySelector("textarea")!;
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "Keep these unsaved edits");

  await grant(false);
  expect(button(screen, "Save").disabled).toBe(true);
  expect(screen.container.querySelector("textarea")).toBe(textarea);

  await grant(true);
  await clickSave(screen);
  expect(onSave).toHaveBeenCalledExactlyOnceWith("Keep these unsaved edits");
});

it("completes @mentions and !references on Enter, and Escape closes the list until the next keystroke", async () => {
  setup();
  permissions.allowed.add(secondary);
  await using screen = await openEditor({ value: "" });
  const textarea = screen.container.querySelector("textarea")!;
  await userEvent.type(textarea, "Thanks @ju");
  await expect.element(page.getByRole("option", { name: /julius/ })).toBeVisible();

  await userEvent.keyboard("{Enter}");
  expect(textarea.value).toBe("Thanks @julius ");
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();

  await userEvent.type(textarea, "and @");
  await expect.element(page.getByRole("option", { name: /theo/ })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
  await userEvent.type(textarea, "t");
  await expect.element(page.getByRole("option", { name: /theo/ })).toBeVisible();

  await userEvent.type(textarea, " fixes !1");
  await expect.element(page.getByRole("option", { name: /Fix/ })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(textarea.value).toBe("Thanks @julius and @t fixes !12 ");
  expect(onCancel).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
});
