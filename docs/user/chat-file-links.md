# Open files linked in chat

File links in a conversation open according to the file and environment:

- Workspace source files, such as TypeScript, open in T3 Code's file panel. If a source file is
  outside the workspace, T3 Code uses your configured editor instead.
- In the desktop app, documents and generated artifacts from the primary environment that shares
  the desktop host's filesystem open in the operating system's default application. For example,
  HTML opens in your default browser and images open in your default image viewer.
- Files from remote environments stay in T3 Code: browser-previewable files open in the integrated
  browser, while other files use the configured editor.

If the operating system cannot open a local file, T3 Code shows the error in the conversation
instead of ignoring the click.
