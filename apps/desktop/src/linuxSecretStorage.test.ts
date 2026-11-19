import { describe, expect, it } from "vite-plus/test";

import {
  parseDbusSendStrings,
  resolveLinuxPasswordStoreSwitch,
  type LinuxSessionBus,
} from "./linuxSecretStorage.ts";

const emptyBus: LinuxSessionBus = { listNames: () => [], getNameOwner: () => null };

const autoSwitch = (env: NodeJS.ProcessEnv, sessionBus = emptyBus, hasSavedSecrets = false) =>
  resolveLinuxPasswordStoreSwitch({
    preference: "auto",
    env,
    sessionBus,
    hasSavedSecrets: () => hasSavedSecrets,
  });

const busWith = (
  owners: Record<string, string>,
  activatable: ReadonlyArray<string> = [],
): LinuxSessionBus => ({
  listNames: () => [...Object.keys(owners), ...activatable],
  getNameOwner: (name) => owners[name] ?? null,
});

describe("linuxSecretStorage", () => {
  it("leaves canonical KDE sessions to Electron's own wallet selection", () => {
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "KDE" })).toBeNull();
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "6" })).toBeNull();
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "5" })).toBeNull();
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "KDE:plasma" })).toBeNull();
  });

  it("recognizes a known desktop later in a colon-separated XDG_CURRENT_DESKTOP list", () => {
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "niri:GNOME" })).toBeNull();
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBeNull();
  });

  it("forces gnome-libsecret for unrecognized Linux desktop sessions", () => {
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "niri" })).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "Hyprland" })).toBe("gnome-libsecret");
    expect(autoSwitch({})).toBe("gnome-libsecret");
  });

  it("forces gnome-libsecret for desktops Electron recognizes but leaves on basic text", () => {
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "LXQt" })).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "LXQt:GNOME" })).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "LXQt:KDE" })).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "LXQt:plasma" })).toBe("gnome-libsecret");
  });

  it("forces KWallet when it is the only keyring on the session bus", () => {
    const lxqt = { XDG_CURRENT_DESKTOP: "LXQt" };
    expect(autoSwitch(lxqt, busWith({}, ["org.kde.kwalletd6"]))).toBe("kwallet6");
    expect(autoSwitch(lxqt, busWith({ "org.kde.kwalletd5": ":1.4" }))).toBe("kwallet5");
    expect(
      autoSwitch(
        { XDG_CURRENT_DESKTOP: "niri" },
        busWith({ "org.kde.kwalletd6": ":1.4", "org.freedesktop.secrets": ":1.4" }),
      ),
    ).toBe("kwallet6");
    expect(
      autoSwitch(
        { XDG_CURRENT_DESKTOP: "GNOME" },
        busWith({ "org.kde.kwalletd6": ":1.4", "org.freedesktop.secrets": ":1.4" }),
      ),
    ).toBeNull();
  });

  it("keeps gnome-libsecret when another keyring may serve the Secret Service", () => {
    const lxqt = { XDG_CURRENT_DESKTOP: "LXQt" };
    expect(
      autoSwitch(lxqt, busWith({ "org.kde.kwalletd5": ":1.4", "org.freedesktop.secrets": ":1.7" })),
    ).toBe("gnome-libsecret");
    expect(autoSwitch(lxqt, busWith({}, ["org.kde.kwalletd6", "org.freedesktop.secrets"]))).toBe(
      "gnome-libsecret",
    );
    expect(
      autoSwitch(
        lxqt,
        busWith({ "org.kde.kwalletd6": ":1.4", "org.freedesktop.secrets": ":1.4" }),
        true,
      ),
    ).toBe("gnome-libsecret");
    expect(
      autoSwitch(lxqt, {
        listNames: () => {
          throw new Error("no session bus");
        },
        getNameOwner: () => null,
      }),
    ).toBe("gnome-libsecret");
  });

  it("reads strings from dbus-send replies", () => {
    expect(
      parseDbusSendStrings(
        'method return time=1 sender=org.freedesktop.DBus\n   array [\n      string "org.freedesktop.DBus"\n      string ":1.4"\n   ]\n',
      ),
    ).toEqual(["org.freedesktop.DBus", ":1.4"]);
  });

  it("does not treat lowercase desktop names as ones Electron recognizes", () => {
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "gnome" })).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "xfce" })).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "kde", KDE_SESSION_VERSION: "6" })).toBe(
      "gnome-libsecret",
    );
  });

  it("overrides KDE sessions identified only by legacy variables", () => {
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "plasma" })).toBe("gnome-libsecret");
    for (const session of [
      "kde",
      "kde-plasma",
      "kde4",
      "plasma",
      "plasmawayland",
      "plasmawayland-dev",
      "plasmax11",
      "plasmax11-dev",
    ]) {
      expect(autoSwitch({ DESKTOP_SESSION: session })).toBe("gnome-libsecret");
      expect(autoSwitch({ XDG_SESSION_DESKTOP: session })).toBe("gnome-libsecret");
      expect(autoSwitch({ GDMSESSION: session })).toBe("gnome-libsecret");
    }
    expect(autoSwitch({ DESKTOP_SESSION: "kde", KDE_SESSION_VERSION: "6" })).toBe(
      "gnome-libsecret",
    );
    expect(autoSwitch({ KDE_SESSION_VERSION: "6" })).toBe("gnome-libsecret");
    expect(autoSwitch({ KDE_FULL_SESSION: "true", KDE_SESSION_VERSION: "6" })).toBe(
      "gnome-libsecret",
    );
  });

  it("ignores stale session hints when XDG_CURRENT_DESKTOP is authoritative", () => {
    expect(
      autoSwitch({ XDG_CURRENT_DESKTOP: "niri", DESKTOP_SESSION: "gnome", GDMSESSION: "gnome" }),
    ).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "niri", KDE_SESSION_VERSION: "6" })).toBe(
      "gnome-libsecret",
    );
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "niri", XDG_SESSION_DESKTOP: "GNOME" })).toBe(
      "gnome-libsecret",
    );
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "niri:plasma" })).toBe("gnome-libsecret");
    expect(
      autoSwitch({
        XDG_CURRENT_DESKTOP: "Hyprland",
        XDG_SESSION_DESKTOP: "KDE",
        KDE_SESSION_VERSION: "6",
      }),
    ).toBe("gnome-libsecret");
  });
});
