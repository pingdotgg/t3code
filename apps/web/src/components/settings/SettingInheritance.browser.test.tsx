import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { getTranslationsSnapshot, GTProvider } from "gt-react";
import { expect, it } from "vite-plus/test";

import { initializeI18n } from "~/i18n/initializeI18n";
import { render } from "../../../test/render";
import { SettingInheritance } from "./SettingInheritance";

const environmentId = EnvironmentId.make("laptop");
const target = {
  environmentId,
  label: "Laptop",
  projectId: null,
  ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null),
};
const overridingProjects = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    environmentId,
    projectId: ProjectId.make(`project-${index}`),
    label: `Project ${index}`,
    open: () => {},
  }));

async function renderCounts(locale: string) {
  const translations = await getTranslationsSnapshot(locale);
  return render(
    <GTProvider locale={locale} translations={translations}>
      {[1, 2].map((count) => (
        <SettingInheritance
          key={count}
          state="default"
          summary="Built-in default"
          targets={[target]}
          environments={[]}
          keys={["worktreeCleanup"]}
          overridingProjects={overridingProjects(count)}
        />
      ))}
    </GTProvider>,
  );
}

it("names the project override count in the UI language", async () => {
  initializeI18n(() => {});
  {
    await using screen = await renderCounts("en");
    for (const name of [
      "Built-in default · 1 project override. Show where this value comes from",
      "Built-in default · 2 project overrides. Show where this value comes from",
    ]) {
      await expect.element(screen.getByRole("button", { name, exact: true })).toBeVisible();
    }
  }
  await using screen = await renderCounts("de");
  for (const name of [
    "Built-in default · 1 Projektüberschreibung. Herkunft dieses Werts anzeigen",
    "Built-in default · 2 Projektüberschreibungen. Herkunft dieses Werts anzeigen",
  ]) {
    await expect.element(screen.getByRole("button", { name, exact: true })).toBeVisible();
  }
});
