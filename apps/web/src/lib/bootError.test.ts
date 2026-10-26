import type { DesktopBridge, DesktopCliCommandState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveTriageCommand } from "./bootError";

const desktopWith = (getState: () => Promise<DesktopCliCommandState>) =>
  ({ cliCommand: { getState } }) as unknown as DesktopBridge;

const notOnPath = (launcherPath: string | null): DesktopCliCommandState => ({
  supported: launcherPath !== null,
  installedPath: null,
  onPath: false,
  launcherPath,
});

describe("resolveTriageCommand", () => {
  it("prefers t3 on PATH, then the desktop launcher", async () => {
    const onPath = { ...notOnPath("/home/me/.t3/bin/t3"), onPath: true };
    await expect(resolveTriageCommand(desktopWith(async () => onPath))).resolves.toBe("t3 triage");
    await expect(
      resolveTriageCommand(desktopWith(async () => notOnPath("/home/me/.t3/bin/t3"))),
    ).resolves.toBe("/home/me/.t3/bin/t3 triage");
  });

  it("quotes launcher paths for the shell that runs them", async () => {
    await expect(
      resolveTriageCommand(desktopWith(async () => notOnPath("/Users/O'Neil/.t3/bin/t3"))),
    ).resolves.toBe(`'/Users/O'"'"'Neil/.t3/bin/t3' triage`);
    await expect(
      resolveTriageCommand(desktopWith(async () => notOnPath("C:\\Users\\Me\\.t3\\bin\\t3.cmd"))),
    ).resolves.toBe("C:\\Users\\Me\\.t3\\bin\\t3.cmd triage");
    await expect(
      resolveTriageCommand(
        desktopWith(async () => notOnPath("C:\\Users\\Jo O'Neil\\.t3\\bin\\t3.cmd")),
      ),
    ).resolves.toBe("& 'C:\\Users\\Jo O''Neil\\.t3\\bin\\t3.cmd' triage");
  });

  it("falls back to npx without a usable desktop launcher", async () => {
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveTriageCommand(undefined)).resolves.toBe("npx t3 triage");
    await expect(resolveTriageCommand({} as DesktopBridge)).resolves.toBe("npx t3 triage");
    await expect(resolveTriageCommand(desktopWith(async () => notOnPath(null)))).resolves.toBe(
      "npx t3 triage",
    );
    const staleWindowsPathEntry = { ...notOnPath(null), supported: true, onPath: true };
    await expect(
      resolveTriageCommand(desktopWith(async () => staleWindowsPathEntry)),
    ).resolves.toBe("npx t3 triage");
    await expect(
      resolveTriageCommand(desktopWith(() => Promise.reject(new Error("ipc closed")))),
    ).resolves.toBe("npx t3 triage");
  });
});
