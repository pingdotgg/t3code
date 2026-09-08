# Devices

The Device panel shows a live iOS Simulator or Android Emulator next to a
thread, so you can watch an agent verify mobile work and tap the device
yourself. Agents get the same device through `device_*` tools and the
`agent-device` command line, which T3 Code sets up for them.

## Open a device

Open the right panel in a project thread and choose **Device**. On first use,
the panel walks through three steps: starting the device hub, checking iOS and
Android support, and choosing whether agents may control devices. Opening the
panel alone does not download or start anything. If the hub is already
installed, the setup screen says so and reuses it.

Choose a running device to watch it, or choose **Start** next to a stopped
device to boot it. The panel shows when you or an agent starts a device.
Turn off the device hub in **Settings → Integrations → Devices** to stop the
helper processes; simulators and emulators keep running until you power them
off.

Simulators run on the machine that hosts the environment server. iOS needs
macOS with Xcode. Android needs the SDK Platform-Tools, Android Emulator,
and Command-line Tools (latest), plus a virtual device created in Android
Studio's Device Manager. T3 Code detects standard SDK locations; set
`ANDROID_HOME` for a custom location. The panel explains missing dependencies.
After installing them, restart the environment server and refresh devices.

The screen is interactive: click and drag to touch, type while the screen is
focused, and use the toolbar for Home, Back, and Recents on Android, rotate on
iOS, and power off. Close the tab to stop watching; the device keeps running
unless you power it off.

## Tools

The toolbar's **Tools** button opens a drawer for the open device. It shows the
foreground app, and lets you switch light and dark mode, change text size,
flip accessibility settings, overlay the accessibility element frames on the
screen, set a fake location, and grant or revoke app permissions. iOS also
exposes Liquid Glass, color filters, VoiceOver, and sending a test push
notification; Android adds orientation and toggling the network. The drawer
only shows what the platform can do, and every control reflects the value read
back from the device after a change.

## Agents and devices

When an agent opens a device, the panel opens in every client connected to the
thread. Agents drive the device through the `agent-device` command line. T3
Code installs and starts it only after **Agent device access** is enabled. iOS
taps build a small test runner on first use, which takes a couple of minutes
once per server. Restart an existing agent session after granting access so it
receives the device CLI environment.

To keep agents away from simulators, turn off **Agent device access** in
**Settings → Integrations → Devices**. This hides the device tools from agents
started from then on; your own Device panel is unaffected.

## Remote connections

The device stream goes through the environment server, so it works over the
local network, Tailscale, and T3 Connect. Live video needs a secure page
(HTTPS or localhost); on a plain-HTTP remote origin iOS falls back to a slower
still-image stream and Android cannot show video.
