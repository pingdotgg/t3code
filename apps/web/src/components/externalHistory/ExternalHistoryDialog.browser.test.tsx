import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ExternalHistoryError,
  type ExternalHistoryRequest,
  type ExternalHistoryResponse,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  config: null as unknown,
  allowed: null as unknown,
  sources: null as unknown,
  first: null as unknown,
  next: null as unknown,
  read: null as unknown,
  readNext: null as unknown,
  requests: [] as ExternalHistoryRequest[],
  update: vi.fn(),
}));
vi.mock(
  import("../../state/server"),
  () =>
    ({
      serverEnvironment: {
        configValueAtom: () => state.config,
        updateSettings: { permissionAtom: () => state.allowed },
      },
    }) as never,
);
vi.mock(
  import("../../state/externalHistory"),
  () =>
    ({
      externalHistory: {
        query: ({ input }: { input: ExternalHistoryRequest }) => {
          state.requests.push(input);
          if (input.operation === "sources") return state.sources;
          if (input.operation === "search") return input.cursor ? state.next : state.first;
          return input.textOffset ? state.readNext : state.read;
        },
      },
    }) as never,
);
vi.mock(
  import("../../state/use-atom-command"),
  () => ({ useAtomCommand: () => state.update }) as never,
);

import { ExternalHistoryButton } from "./ExternalHistoryDialog";

const environmentId = EnvironmentId.make("native-history-browser");
const ref = {
  sourceId: "codex-source",
  threadId: "native-thread",
  readCursor: "exact-native-locator",
  digest: "b".repeat(64),
};
const configFor = (enabled: boolean, supported = true) => ({
  environment: { capabilities: supported ? { externalHistory: 1 as const } : {} },
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    externalHistory: { enabled, chatGptExportPaths: ["/exports/conversations.json"] },
  },
});
const success = (data: ExternalHistoryResponse) => Atom.make(AsyncResult.success(data));

it("continues an empty bounded search, opens exact source pages, and hides revoked or changed evidence", async () => {
  const registry = AtomRegistry.make();
  const config = Atom.make(configFor(true));
  const allowed = Atom.make(true);
  state.config = config;
  state.allowed = allowed;
  state.requests = [];
  state.update.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.sources = success({
    operation: "sources",
    enabled: true,
    sources: [{ id: ref.sourceId, label: "Local Codex history", kind: "codex" }],
  });
  state.first = success({
    operation: "search",
    matches: [],
    examinedItems: 20,
    nextCursor: "next-bounded-page",
  });
  state.next = success({
    operation: "search",
    matches: [
      {
        ref,
        threadTitle: "Native compiler investigation",
        itemId: "native-command",
        role: "tool",
        excerpt: "remaining exact source text",
        textOffset: 16,
        totalChars: 43,
      },
    ],
    examinedItems: 10,
    nextCursor: null,
  });
  state.read = success({
    operation: "read",
    ref,
    threadTitle: "Native compiler investigation",
    role: "tool",
    text: "first exact page",
    textOffset: 0,
    totalChars: 43,
    nextTextOffset: 16,
  });
  const readNext = Atom.make<
    AsyncResult.AsyncResult<ExternalHistoryResponse, ExternalHistoryError>
  >(
    AsyncResult.success<ExternalHistoryResponse, ExternalHistoryError>({
      operation: "read",
      ref,
      threadTitle: "Native compiler investigation",
      role: "tool",
      text: "remaining exact source text",
      textOffset: 16,
      totalChars: 43,
      nextTextOffset: null,
    }),
  );
  state.readNext = readNext;

  await using _screen = await render(
    <RegistryContext.Provider value={registry}>
      <ExternalHistoryButton environmentId={environmentId} currentProjectPath="/current-project" />
    </RegistryContext.Provider>,
  );
  await page.getByRole("button", { name: "External history", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "ChatGPT export paths" }))
    .toHaveValue("/exports/conversations.json");
  await page.getByRole("textbox", { name: "Search external history" }).fill("source");
  await page.getByRole("button", { name: "This project", exact: true }).click();
  await page.getByRole("switch", { name: "Include archived Codex threads" }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect
    .element(page.getByText("No matches on this page. Continue to search the next page."))
    .toBeVisible();
  await page.getByRole("button", { name: "Continue search", exact: true }).click();
  await expect
    .element(page.getByText("Native compiler investigation", { exact: true }))
    .toBeVisible();
  expect(state.requests).toContainEqual({
    operation: "search",
    sourceId: ref.sourceId,
    query: "source",
    filterCwd: "/current-project",
    includeArchived: true,
    cursor: "next-bounded-page",
  });
  await page.getByRole("button", { name: "Open source", exact: true }).click();
  await expect.element(page.getByText("first exact page", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More source text", exact: true }).click();
  await expect
    .element(page.getByText("remaining exact source text", { exact: true }))
    .toBeVisible();
  expect(state.requests).toContainEqual({
    operation: "read",
    ref,
    textOffset: 16,
    maxChars: 12_000,
  });
  registry.set(
    readNext,
    AsyncResult.failure(Cause.fail(new ExternalHistoryError({ reason: "changed" }))),
  );
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The source changed. Search again before opening this evidence.");
  await expect
    .element(page.getByText("remaining exact source text", { exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect
    .element(page.getByText("No matches on this page. Continue to search the next page."))
    .toBeVisible();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  registry.set(allowed, false);
  await expect
    .element(page.getByRole("switch", { name: "Allow external history search" }))
    .toBeDisabled();
  await expect.element(page.getByRole("textbox", { name: "ChatGPT export paths" })).toBeDisabled();
  registry.set(config, configFor(false));
  await expect
    .element(page.getByText("External history search is off for this environment."))
    .toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Search external history" }))
    .not.toBeInTheDocument();
  registry.set(config, configFor(false, false));
  await expect
    .element(page.getByRole("button", { name: "External history", exact: true }))
    .not.toBeInTheDocument();
});
