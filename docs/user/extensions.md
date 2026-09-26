# Environment extensions

Environment extensions add tools and views to T3 Code. Install a package in the environment that owns the projects it will use. Extension views are available in web and desktop; the mobile app does not support them.

Packages run trusted code in the environment and client. Install only code you trust. Project and capability grants control access to T3-provided services; they do not sandbox the package.

## Install a package

1. Open **Settings → Integrations → Environment extensions** and select the environment.
2. Enter the package directory on that environment's machine. A path on your client machine will not work for a remote environment unless the package also exists there.
3. Select the projects and capabilities to grant. Check each project's workspace path, especially when projects have the same name.
4. Read and select the trust acknowledgement, then choose **Install package**.

Managing packages requires access-management permission on the selected environment. Installation does not automatically open a view.

## Use an extension

Open a thread in an allowed project and choose a compatible view from the thread header's **Extensions** menu. Extensions can appear in a side panel or bottom dock.

For the workspace reader, enter a relative file path and choose **Read file**. To include the last successful read in a prompt, explicitly select its composer context contribution. Reading alone does not add text to your prompt. Review the captured text before sending; it is a snapshot, so read and select again when you need newer content.

An extension can also provide agent tools. Availability depends on its enabled state, project and capability grants, and the provider session. A view and an agent tool are separate contributions; a package need not provide both.

## Disable, update or remove

Return to **Environment extensions** to choose **Disable**, **Enable** or **Remove**. Disabling makes the package unavailable and revokes its T3-provided operations. Captured context already in drafts or messages remains readable. Saved views can show a fallback until their extension is available again.

To update, enter the replacement package directory, acknowledge trust and choose **Update from package directory** on the package. Updates keep existing grants. To change permissions, select the intended projects and capabilities, then choose **Apply selected permissions** on the package. This replaces all its existing permissions. An empty selection revokes all T3-provided access without removing the package.

Changes made from another connected client appear automatically on supported environments. Use **Refresh extensions** with older environments. Calls authorized before a permission change cannot return obsolete results after revocation.

Choose **Roll back package** to restore the previous installed version after an update. Rollback keeps the current permissions and checks dependencies again; it does not reverse changes the package made to files or other services.

## API providers and dependencies

Packages can provide APIs for other packages and require compatible dependencies. Install required dependencies separately. Missing, disabled or incompatible dependencies make the dependent package unavailable. Installing a package does not grant it permission to control other features.

When a package offers a shared API, choose **Use for** that API to select its provider. Selection does not add permissions. Conflicting providers require an explicit choice; a disabled selected provider shows an unavailable state.

A compatible Files provider can replace the ordinary Files presentation with its own installed view. The current example supports browsing and reading text; it does not provide the full built-in editor. The other built-in panels remain bundled integrations and cannot yet be replaced by independently installed packages.
