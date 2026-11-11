import { EnvironmentId, ThreadId, type ThreadSpecialist } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  specialist: undefined as ThreadSpecialist | undefined,
  patches: [] as Array<ThreadSpecialist | null>,
}));

vi.mock(import("../../state/entities"), () => ({
  useThreadProjection: (() =>
    state.specialist === undefined
      ? { projection: { thread: { specialist: undefined } } }
      : { projection: { thread: { specialist: state.specialist } } }) as never,
}));

vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() =>
    async (value: { readonly input: { readonly specialist: ThreadSpecialist | null } }) => {
      state.patches.push(value.input.specialist);
      return AsyncResult.success(undefined);
    }) as never,
}));

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadEnvironment: {
      ...actual.threadEnvironment,
      setSpecialist: { label: "set-specialist", run: async () => undefined } as never,
    },
  };
});

import { render } from "../../../test/render";
import { ToastProvider } from "../ui/toast";
import { ThreadSpecialistLoadoutPanel } from "./ThreadSpecialistLoadoutPanel";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("specialist");

const bound: ThreadSpecialist = {
  key: "vault",
  label: "Vault",
  skills: ["vault-user"],
  mcpServers: {
    vault: { type: "stdio", command: "vault-mcp", args: ["serve"] },
  },
};

function setup(specialist?: ThreadSpecialist) {
  state.specialist = specialist;
  state.patches = [];
}

const panel = (
  <ToastProvider>
    <ThreadSpecialistLoadoutPanel environmentId={environmentId} threadId={threadId} />
  </ToastProvider>
);

it("hides while the role has no skills or MCP servers", async () => {
  setup({ key: "vault", label: "Vault" });
  await using screen = await render(panel);
  expect(screen.container.querySelector("#thread-details-role-heading")).toBeNull();
});

it("lists role skills and MCP with a From role source line", async () => {
  setup(bound);
  await using screen = await render(panel);
  expect(page.getByText("vault-user")).toBeTruthy();
  expect(screen.container.textContent).toContain("From role · @vault");
  expect(screen.container.textContent).toContain("stdio");
  expect(page.getByRole("button", { name: "Remove skill vault-user" })).toBeTruthy();
  expect(page.getByRole("button", { name: "Remove MCP server vault" })).toBeTruthy();
});

it("removes a skill from the specialist binding", async () => {
  setup(bound);
  await using _screen = await render(panel);
  await userEvent.click(page.getByRole("button", { name: "Remove skill vault-user" }));
  expect(state.patches).toEqual([
    {
      key: "vault",
      label: "Vault",
      mcpServers: {
        vault: { type: "stdio", command: "vault-mcp", args: ["serve"] },
      },
    },
  ]);
});

it("removes an MCP server from the specialist binding", async () => {
  setup(bound);
  await using _screen = await render(panel);
  await userEvent.click(page.getByRole("button", { name: "Remove MCP server vault" }));
  expect(state.patches).toEqual([
    {
      key: "vault",
      label: "Vault",
      skills: ["vault-user"],
    },
  ]);
});
