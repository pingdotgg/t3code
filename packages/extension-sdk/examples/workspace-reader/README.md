# Workspace text reader example

This is an independently authored view package using only React and the SDK's public exports. It declares t3.workspace/read-text, saves the selected relative path, and reads only after an explicit click. Restoration does not create a resource or start a read. The view can declare side-panel and bottom-dock support; the application decides which placements it actually implements.

Copy this directory into an external package, rename package.template.json to package.json, and install the emitted @t3tools/extension-sdk tarball with React 19. The source entry is ./workspace-reader.mjs with ./workspace-reader.d.mts declarations. TypeScript checks the JavaScript implementation with allowJs and checkJs. This sample does not import a native Files renderer, app bindings, server internals or credentials. The app adapter lives outside the sample.

Trusted web bootstrap imports workspaceReader, creates options with createAppWorkspaceReadHostOptions({ extensionId: workspaceReader.manifest.id, environmentId, projectId, isEnabled }), then calls registerWorkspaceExtension(workspaceReader, options). That bootstrap API is application integration, not another SDK export. isEnabled belongs to the host and must reflect revocation. Default registration without options denies service access. Registration does not open a view; open the generic ViewRecord through the layout intent separately.

The capability input is exactly { relativePath: string }, using forward-slash segments. The result is { relativePath: string, contents: string, byteLength: number, truncated: boolean }. byteLength retains the backend's source byte count; returned text may be shorter. The adapter bounds the complete encoded JSON to 64 KiB, including escaping and metadata.

The adapter derives cwd from the live environment's project and optional matching thread/worktree. The caller cannot provide cwd or override the granted environment/project. It rejects absolute/drive/UNC paths, backslashes, traversal and control characters. The existing backend relative-read path checks canonical symlink containment. Those checks are ordinary filesystem confinement, not an OS sandbox against malicious same-user code or filesystem races.

Workspace revision is a serialized pair of the project root and optional thread worktree path. If a record includes workspaceRevision it must match that adapter value. The adapter re-resolves membership/root after the read and refuses changed results. This is a workspace-target revision, not a filesystem-content version. The capability is read-only; it grants neither write nor agent control.

The host checks grants on invocation, and this adapter checks again before returning a result. Hiding/unregistering aborts SDK activity; the query waiter receives the signal and late responses are rejected. Existing RPC/backend cancellation may be cooperative; this does not promise that all filesystem work already in flight stops. The sample drops superseded/hidden results and preserves the user's path across hide/show.

This is a trusted in-process developer API. A React package can execute arbitrary same-origin JavaScript; grants constrain the host-mediated API, not arbitrary code. There is no server package loader, marketplace, sandbox, model tool or mobile renderer in this example.
