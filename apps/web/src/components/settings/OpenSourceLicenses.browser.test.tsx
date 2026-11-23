import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { AppRouteModal } from "../AppRouteModal";
import { OpenSourceLicensesPanel } from "./OpenSourceLicenses";

vi.mock("../chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

it("Esc in the license search closes it without closing Settings", async () => {
  const entry = {
    bundles: ["web"],
    kind: "package",
    license: "MIT",
    name: "react",
    noticeText: "MIT License",
    sourceUrl: null,
    version: "19.0.0",
  };
  const realFetch = globalThis.fetch.bind(globalThis);
  using _fetch = stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    (input instanceof Request ? input.url : String(input)).endsWith("/third-party-licenses.json")
      ? Promise.resolve(Response.json({ schemaVersion: 1, entries: [entry] }))
      : realFetch(input, init),
  );
  await using _screen = await render(
    <AppRouteModal label="Settings">
      <OpenSourceLicensesPanel />
    </AppRouteModal>,
    { router: "/settings/open-source-licenses" },
  );
  const settings = page.getByRole("dialog", { name: "Settings" });
  const search = page.getByRole("searchbox", { name: "Search licenses" });
  await expect.element(search).toBeVisible();
  await search.fill("react");

  await userEvent.keyboard("{Escape}");

  await expect.element(settings).toHaveAttribute("data-open");
  await expect.element(search).toHaveValue("");

  await userEvent.keyboard("{Escape}");

  await expect.element(settings).not.toBeInTheDocument();
});
