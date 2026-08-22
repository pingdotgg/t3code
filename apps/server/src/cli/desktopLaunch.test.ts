import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  DESKTOP_APP_NAMES,
  isT3LinuxDesktopEntry,
  linuxDesktopEntryLaunchIds,
  windowsDesktopExecutableCandidates,
} from "./desktopLaunch.ts";

it("lists stable and nightly desktop app names", () => {
  assert.include(DESKTOP_APP_NAMES as ReadonlyArray<string>, "T3 Code (Alpha)");
  assert.include(DESKTOP_APP_NAMES as ReadonlyArray<string>, "T3 Code (Nightly)");
});

it("resolves common Windows install paths under Local AppData", () => {
  const localAppData = "/Users/test/AppData/Local";
  const candidates = windowsDesktopExecutableCandidates(localAppData);
  assert.include(
    candidates,
    NodePath.join(localAppData, "Programs", "t3-code", "T3 Code (Alpha).exe"),
  );
  assert.include(
    candidates,
    NodePath.join(localAppData, "Programs", "T3 Code (Nightly)", "T3 Code (Nightly).exe"),
  );
});

it("recognizes AppImage-minted Linux desktop entries for gtk-launch", () => {
  assert.isTrue(
    isT3LinuxDesktopEntry(`[Desktop Entry]
Name=T3 Code (Alpha)
Exec=/home/user/T3-Code-Alpha.AppImage %U
Type=Application
`),
  );
  assert.deepEqual(
    linuxDesktopEntryLaunchIds([
      {
        fileName: "appimagekit_7f3a-T3_Code_Alpha.desktop",
        contents: `[Desktop Entry]
Name=T3 Code (Alpha)
Exec=/tmp/T3-Code-Alpha.AppImage
`,
      },
      {
        fileName: "firefox.desktop",
        contents: `[Desktop Entry]
Name=Firefox
Exec=firefox
`,
      },
      {
        fileName: "com.t3tools.t3code.desktop",
        contents: `[Desktop Entry]
Name=T3 Code
StartupWMClass=com.t3tools.t3code
`,
      },
    ]),
    ["appimagekit_7f3a-T3_Code_Alpha", "com.t3tools.t3code"],
  );
});
