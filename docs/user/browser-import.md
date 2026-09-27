# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Integrations → Browser profiles → Add profile**, then choose a browser under
**Import from**. Close the source browser before importing, and allow an operating-system keyring
unlock prompt if one appears.

This is a one-time copy. Later login changes stay separate between the two browsers, and some
sites may still require you to sign in again.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag T3 Code into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen T3 Code before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

On Windows, import supports Firefox and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.

## Passkeys

On macOS 14.4 or later, builds authorized for browser passkeys can use existing passkeys from
Apple Passwords/iCloud Keychain and enabled system credential providers. Choose the website's
explicit passkey sign-in action, then approve the system prompt. Your provider must expose its
passkeys to macOS; installing a browser extension alone does not make them available here.

Passkeys remain with the credential provider and can be shared across preview profiles, including
private tabs. Creating a passkey in a private tab can therefore save it permanently. Clearing cookies
or deleting a browser profile does not delete passkeys; manage them in your credential provider.
Automatic passkey autofill and passkey requests inside embedded frames are not supported by this
macOS integration. Unsigned builds cannot access the system browser passkey APIs.
