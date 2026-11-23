import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { ExtensionInstallForm } from "./ExtensionInstallForm";

const mocks = vi.hoisted(() => ({ install: vi.fn() }));

vi.mock("../../state/extensions", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return { extensionEnvironment: { install: { permissionAtom: () => allowed } } };
});

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.install }));

vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: () => ({}) },
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false }),
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => ({
    data: query
      ? { entries: [{ name: "other-extension", fullPath: "/workspace/other-extension" }] }
      : undefined,
    isPending: false,
  }),
}));

it("keeps the submitted folder selected until the installation settles", async () => {
  const installation = Promise.withResolvers<never>();
  mocks.install.mockReset().mockReturnValue(installation.promise);
  await using _screen = await render(
    <ExtensionInstallForm
      environmentId={EnvironmentId.make("test")}
      baseDirectory="/workspace/extension/"
      platform="linux"
      onInstalled={vi.fn()}
    />,
  );

  await page.getByRole("button", { name: "Browse", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Extension source" });
  const parent = page.getByRole("button", { name: "..", exact: true });
  const other = page.getByRole("button", { name: "other-extension", exact: true });
  await expect.element(source).toHaveValue("/workspace/extension/");

  await page.getByRole("button", { name: "Install extension", exact: true }).click();
  await expect.element(parent).toBeDisabled();
  await expect.element(other).toBeDisabled();

  await act(() => installation.reject(new Error("Installation failed")));
  await expect.element(page.getByRole("alert")).toHaveTextContent("Installation failed");
  await expect.element(source).toHaveValue("/workspace/extension/");
  await other.click();
  await expect.element(source).toHaveValue("/workspace/other-extension/");
});
