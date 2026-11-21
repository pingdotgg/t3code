# T3 Code tray

The tray opens the installed desktop app on demand. The T3 background service owns the server and running work, so the desktop app can quit while the server keeps running.

1. Set up T3's [background service](../../docs/user/background-service.md) with `t3 service install`.
2. In the desktop app, turn off **Local environment** under **Settings → Environments** and connect to the background service. See [Using the Desktop App as a Remote Only](../../docs/user/remote-access.md#using-the-desktop-app-as-a-remote-only).
3. Build and start the tray:

   ```sh
   cargo build --locked --release --manifest-path native/tray/Cargo.toml
   native/tray/target/release/t3-tray "/absolute/path/to/T3 Code"
   ```

Pass the installed AppImage or executable on Linux, the executable on Windows (use `t3-tray.exe`), or the installed `.app` bundle on macOS. The primary icon action opens T3 Code where the tray host delivers activation. The native menu offers **Open T3 Code** and **Quit Tray**. Quit the desktop app to release its GUI processes. **Quit Tray** only removes the icon. Use the T3 CLI to manage the server independently.

Linux requires a desktop with a StatusNotifierItem host. macOS uses an accessory app so the tray has a menu-bar icon without a Dock icon. The tray is currently built and started separately from the desktop installer.
