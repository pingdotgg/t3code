# T3 extension SDK

Start with [extension.ts](examples/start-here/extension.ts): a small, typed workspace reader. Change its behavior before reaching for lower-level APIs.

From a directory containing this SDK (installed from its tarball or npm):

    npx --no-install t3-extension create ./my-plugin
    cd my-plugin
    npm install /absolute/path/to/t3tools-extension-sdk-0.1.0.tgz
    npm run build
    npm run check

Use the supplied SDK tarball until a registry release is available. Build emits .t3-extension/: bundled client/server entries, a generated manifest and receipt.json. Install that directory in **Settings → Integrations → Environment extensions** on the target environment, grant the intended project and t3.workspace/read-text, then open **Extensions → Workspace README**. The project needs a README.md. Registration never grants permission.

Edit the source and rebuild; update the installation to load it. Automatic development reload is not implemented. Build/check execute trusted source and verify packaging, not installed behavior. A failed check must not be presented as success.

- [Example and its proof](examples/start-here/README.md)
- [Types and next examples](AUTHORING.md)
- [Source](src/authoring.ts) and [tests](test/authoring.test.mjs) ship in this package.
- [Host integration](HOST.md) is only needed when adding a missing platform capability.

Installed packages run trusted code. Native mobile renderers, full native-panel replacements and remote-mode parity remain separate work.
