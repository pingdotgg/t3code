import { describe, expect, it } from "vite-plus/test";

import { azureCliInstall } from "./azureCliLauncher.ts";

describe("azureCliInstall", () => {
  const msiRoot = "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2";
  const zipRoot = "D:\\azure-cli";
  const cliPackage = (root: string) => `${root}\\Lib\\site-packages\\azure\\cli`;

  const paths =
    (...entries: Array<string>) =>
    (filePath: string) =>
      entries.includes(filePath);

  it("runs the MSI launcher's interpreter", () => {
    expect(
      azureCliInstall(
        `${msiRoot}\\wbin\\az.cmd`,
        paths(`${msiRoot}\\python.exe`, cliPackage(msiRoot)),
      ),
    ).toEqual({ interpreter: `${msiRoot}\\python.exe`, installer: "MSI" });
  });

  it("runs the ZIP launcher's interpreter", () => {
    expect(
      azureCliInstall(
        `${zipRoot}\\bin\\az.cmd`,
        paths(`${zipRoot}\\python.exe`, cliPackage(zipRoot)),
      ),
    ).toEqual({ interpreter: `${zipRoot}\\python.exe`, installer: "ZIP" });
  });

  it("leaves anything that is not the Azure CLI alone", () => {
    expect(azureCliInstall(`${zipRoot}\\bin\\az.exe`, () => true)).toBeUndefined();
    expect(azureCliInstall(`${zipRoot}\\azure-cli\\az.cmd`, () => true)).toBeUndefined();
    // Another tool's `bin\az.cmd` beside a `python.exe`, without the CLI's own packages.
    expect(
      azureCliInstall(`${zipRoot}\\bin\\az.cmd`, paths(`${zipRoot}\\python.exe`)),
    ).toBeUndefined();
    // The CLI's packages without the interpreter its launcher runs.
    expect(azureCliInstall(`${msiRoot}\\wbin\\az.cmd`, paths(cliPackage(msiRoot)))).toBeUndefined();
  });
});
