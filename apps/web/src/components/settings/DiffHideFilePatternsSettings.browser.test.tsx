import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
  persistClientSettingsPatch,
  useMergedSettings,
} from "../../hooks/useSettings";
import { removeLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { useHideTestFiles } from "../diffs/useHideTestFiles";
import { DiffHideFilePatternsSettings } from "./DiffHideFilePatternsSettings";

const persistence = vi.hoisted(() => ({
  saved: null as ClientSettings | null,
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence }),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => useMergedSettings(DEFAULT_SERVER_SETTINGS)) as never,
  useUpdateScopedSettings: (() => persistClientSettingsPatch) as never,
  useClearScopedSettings: () => () => undefined,
  useClearProjectOverrides: () => () => undefined,
}));

const hideTestsKey = "t3code.diffHideTestFiles";
const stories = "src/Button.stories.tsx";
const source = "src/Button.tsx";
const benchmark = "src/render.bench.ts";
const testFile = "src/Button.test.tsx";
const customPatterns = "\\.stories\\.tsx$\n\\.bench\\.ts$";

function VisibleFiles() {
  const filter = useHideTestFiles();
  const files = [source, stories, benchmark, testFile].filter(
    (path) => !filter.hideTestFiles || !filter.matchesHiddenFile(path),
  );
  return (
    <>
      <button onClick={() => filter.setHideTestFiles(!filter.hideTestFiles)}>
        Toggle hidden files
      </button>
      <ul>
        {files.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </>
  );
}

function setup() {
  __resetClientSettingsPersistenceForTests();
  const settings = { ...DEFAULT_CLIENT_SETTINGS, diffHideFilePatterns: "\\.bench\\.ts$" };
  persistence.saved = settings;
  persistence.getClientSettings.mockReset().mockResolvedValue(settings);
  persistence.setClientSettings.mockReset().mockImplementation(async (next) => {
    persistence.saved = next;
  });
  __setClientSettingsForTests(settings);
  setLocalStorageItem(hideTestsKey, true, Schema.Boolean);
  return {
    [Symbol.dispose]() {
      __resetClientSettingsPersistenceForTests();
      removeLocalStorageItem(hideTestsKey);
    },
  };
}

it("keeps invalid drafts out of saved filters and applies, clears, and resets valid patterns", async () => {
  using _settings = setup();
  await using screen = await render(
    <>
      <DiffHideFilePatternsSettings />
      <VisibleFiles />
    </>,
  );
  const editor = screen.getByRole("textbox", { name: "Additional hidden file patterns" });

  await expect.element(screen.getByText(stories, { exact: true })).toBeVisible();
  await expect.element(screen.getByText(benchmark, { exact: true })).not.toBeInTheDocument();

  await editor.fill("[");
  await userEvent.tab();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect.element(editor).toHaveAttribute("aria-invalid", "true");
  expect(getClientSettings().diffHideFilePatterns).toBe("\\.bench\\.ts$");
  expect(persistence.saved?.diffHideFilePatterns).toBe("\\.bench\\.ts$");
  await expect.element(screen.getByText(stories, { exact: true })).toBeVisible();

  await editor.fill(customPatterns);
  await userEvent.tab();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(screen.getByText(stories, { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText(source, { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(persistence.saved?.diffHideFilePatterns).toBe(customPatterns));

  await editor.fill("");
  await userEvent.tab();
  await expect.element(screen.getByText(stories, { exact: true })).toBeVisible();
  await expect.element(screen.getByText(benchmark, { exact: true })).toBeVisible();
  await expect.element(screen.getByText(testFile, { exact: true })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(persistence.saved?.diffHideFilePatterns).toBe(""));

  await editor.fill(customPatterns);
  await userEvent.tab();
  await expect.element(screen.getByText(stories, { exact: true })).not.toBeInTheDocument();
  await editor.fill("[");
  await screen
    .getByRole("button", { name: "Reset additional hidden file patterns to default" })
    .click();
  await expect.element(editor).toHaveValue("");
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(screen.getByText(stories, { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(persistence.saved?.diffHideFilePatterns).toBe(""));

  await screen.getByRole("button", { name: "Toggle hidden files" }).click();
  await expect.element(screen.getByText(testFile, { exact: true })).toBeVisible();
});
