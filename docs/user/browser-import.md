# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Integrations → Browser profiles → Add profile**, then choose a browser under
**Import from**. Close the source browser before importing, and allow an operating-system keyring
unlock prompt if one appears.

This is a one-time copy. Later login changes stay separate between the two browsers, and some
sites may still require you to sign in again.

On macOS, Safari is also available. Safari protects its cookies with Full Disk Access rather than
a keychain, so the import wizard asks you to grant it: **Open System Settings** takes you to the
right pane, and macOS may ask you to quit and reopen T3 Code before the grant applies. You can
revoke Full Disk Access after the import is done. Only Safari's primary profile is imported; cookies
kept by additional Safari profiles are not.

On Windows, import supports Firefox and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.
