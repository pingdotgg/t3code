# Import browser logins

In the desktop app, open **Settings → Integrations → Browser profiles → Add profile**
and choose a browser under **Import from**. The import copies cookies into a T3 Code browser
profile so you can use existing logins in the preview browser. Changes made afterward stay
separate from the source browser.

Linux discovery includes Helium and both native and Snap installations of Firefox. Windows
discovery includes Firefox and Helium builds that still use Windows' standard profile
encryption. Other Chromium-based browsers on Windows use app-bound cookie encryption and cannot
be imported. A browser appears once it has a profile with a cookie database. Close the source
browser before importing; the import wizard will prompt you if it is still running.

On Linux, Chromium-based browsers use your desktop keyring to protect their cookies. T3 Code
includes the keyring reader; no separate command-line tool is needed. Allow the desktop unlock
prompt if one appears. If the keyring cannot be accessed, T3 Code reports that failure when no
cookies can be imported. Partitioned cookies are skipped.

## Separate task logins

For parallel tasks that need different logins, create a **Blank profile** for each task under
**Settings → Integrations → Browser profiles → Add profile**. In the panel tab bar, open
**+ → Browser** and choose that profile.

Agents can read an open tab's `profileId` with `preview_status` and pass that ID to `preview_open`
to create another tab in the same profile. The built-in IDs are `default` and `incognito`;
custom profiles use their ID, not their display name. For example:

```json
{ "profileId": "incognito", "url": "http://localhost:3001" }
```

Supplying `profileId` always creates a new tab. It cannot be combined with `tabId` or
`reuseExistingTab: true`. Subsequent agent actions use the new tab, and the original tab keeps its
profile and login. Unknown profiles are rejected; this does not create a profile.

A new tab shares cookies with other tabs in its profile. Incognito is also shared within an
environment until T3 Code closes, so use separate blank profiles for independent tasks. Both the
server and desktop must support explicit profile selection; an older desktop cannot handle it.
