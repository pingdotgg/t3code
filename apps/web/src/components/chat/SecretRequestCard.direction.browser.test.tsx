import type { SecretRequestItem } from "@t3tools/client-runtime/secret-request";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../../state/server", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("../../state/server")>()),
    serverEnvironment: { answerSecretRequest: {}, configValueAtom: () => Atom.make(null) },
  };
});

import "~/index.css";
import { render } from "../../../test/render";
import { SecretRequestCard } from "./SecretRequestCard";

const renderCard = (
  fields: Pick<SecretRequestItem, "label" | "reason"> & Partial<SecretRequestItem>,
  visibility: "local" | "inherited" = "local",
) =>
  render(
    <SecretRequestCard
      environmentId={EnvironmentId.make("env")}
      visibility={visibility}
      item={{ secretStatus: "pending", ...fields } as SecretRequestItem}
    />,
  );

it("reads a Hebrew request right to left and keeps its code and the typed secret left to right", async () => {
  await using screen = await renderCard({
    label: "טוקן של Vercel",
    reason: "צריך את `VERCEL_TOKEN` כדי לפרוס את הפרויקט.",
    placeholder: "הדבק את הטוקן כאן",
  });
  const label = screen.getByText("טוקן של Vercel", { exact: true });
  await expect.element(label).toHaveStyle({ direction: "rtl", textAlign: "right" });
  const reason = screen.getByText(/כדי לפרוס/);
  await expect.element(reason).toHaveStyle({ direction: "rtl", textAlign: "right" });
  await expect.element(screen.getByText("`VERCEL_TOKEN`")).toHaveStyle({ direction: "ltr" });

  const input = screen.getByLabelText("טוקן של Vercel");
  await expect.element(input).toHaveStyle({ direction: "rtl" });
  await input.click();
  await userEvent.keyboard("abc");
  await expect.element(input).toHaveStyle({ direction: "ltr" });
});

it("gives an English label the card side and keeps its default placeholder left to right when the reason is Hebrew", async () => {
  await using screen = await renderCard({
    label: "GitHub token",
    reason: "צריך אותו כדי לפתוח את ה-PR בשמך.",
  });
  const label = screen.getByText("GitHub token", { exact: true });
  await expect.element(label).toHaveStyle({ direction: "ltr", textAlign: "right" });
  await expect
    .element(screen.getByText(/כדי לפתוח/))
    .toHaveStyle({ direction: "rtl", textAlign: "right" });
  await expect.element(screen.getByLabelText("GitHub token")).toHaveStyle({ direction: "ltr" });
});

it("leaves an English request left to right", async () => {
  await using screen = await renderCard({
    label: "GitHub token",
    reason: "Needed to open the PR for you.",
  });
  await expect
    .element(screen.getByText("GitHub token", { exact: true }))
    .toHaveStyle({ direction: "ltr", textAlign: "left" });
  await expect
    .element(screen.getByText("Needed to open the PR for you."))
    .toHaveStyle({ direction: "ltr", textAlign: "left" });
});

it("isolates a Hebrew label from the English status in the answered row", async () => {
  await using screen = await renderCard({
    label: "טוקן של Vercel",
    reason: "",
    secretStatus: "saved",
  });
  const label = screen.getByText("טוקן של Vercel", { exact: true });
  expect(label.element().tagName).toBe("BDI");
  await expect.element(label).toHaveStyle({ direction: "rtl" });
});
