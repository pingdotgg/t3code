# Devices

The Device panel shows a live iOS Simulator or Android Emulator next to a
thread, so you can watch an agent verify mobile work and tap the device
yourself. Agents get the same device through `device_*` tools and the
`agent-device` command line, which T3 Code sets up for them.

## Open a device

Open the right panel in a project thread and choose **Device**, then pick a
simulator or emulator. A device that is not running boots when you pick it.
The first time, T3 Code installs its device tools on the server; that takes a
minute and happens once.

Simulators run on the machine that hosts the environment server. iOS needs
macOS with Xcode. Android needs the Android SDK with `ANDROID_HOME` set or
`adb` on the path. The panel says which platforms the server can run and why one
cannot.

The screen is interactive: click and drag to touch, type while the screen is
focused, and use the toolbar for Home, Back, and Recents on Android, rotate on
iOS, and power off. Close the tab to stop watching; the device keeps running
unless you power it off.

## Agents and devices

When an agent opens a device, the panel opens in every client connected to the
thread. Agents drive the device through the `agent-device` command line, which
T3 Code preinstalls and connects for them. iOS taps through `agent-device` build
a small test runner on first use, which takes a couple of minutes once per
server.

To keep agents away from simulators, turn off **Agent device access** in
Settings → Projects → Project defaults. This hides the device tools from agents
started from then on; your own Device panel is unaffected.

## Remote connections

The device stream goes through the environment server, so it works over the
local network, Tailscale, and T3 Connect. Live video needs a secure page
(HTTPS or localhost); on a plain-HTTP remote origin iOS falls back to a slower
still-image stream and Android cannot show video.
