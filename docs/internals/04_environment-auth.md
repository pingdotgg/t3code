# Environment authentication

The environment issues its own sessions and enforces their capabilities. Cloud identity and relay
credentials belong to a separate trust boundary, described in [T3 Connect](./06_t3-connect.md). A relay
token is never an environment login. See [SECURITY.md](../../SECURITY.md) for the overall threat
model.

## Scoped sessions and delegation

- **Narrowing only.** Pairing delegates a set of scopes. Exchanging a bootstrap credential can
  narrow a grant, never widen it. Client labels and device metadata have no authorization role.
- **`access:write` hands out what the session holds and revokes anything.** Every route that
  returns a credential to the caller requires `access:write` and every scope that credential
  carries: a pairing link, an MCP sign-in approval, a link code from a linked environment, and a
  guest link (which reads a thread). Revoking is not capped by the caller's scopes. Admitting a
  T3 Connect device is not delegation; see [T3 Connect](./06_t3-connect.md).
- **Why the default grant includes management scopes.** `terminal:operate` and
  `orchestration:operate` already grant OS-user execution (which can invoke `t3 auth session issue`),
  so withholding access or relay management from the default grant would not be a real boundary.
  Narrower clients receive explicit scopes.
- **No recoverable secrets in read models.** Only the creation response returns a raw pairing
  credential; access listings expose metadata only.
- **DPoP binding.** Browser cookies, bearer tokens, and DPoP tokens share the scoped session model.
  DPoP binds tokens to a client proof key; an invalid proof must fail rather than fall back to
  bearer auth. Plain paired DPoP sessions renew in place so live sockets and Sharing & access rows
  stay stable; T3 Connect, CLI, and desktop sessions never self-renew so revoking/unlinking cuts
  them off.
- **WebSocket tickets and per-RPC authorization.** Bearer and DPoP clients mint short-lived tickets
  over authenticated HTTP so long-lived tokens never appear in socket URLs. DPoP RPC tickets stay
  proof-key bound at upgrade. A successful handshake grants no extra authority: every RPC declares
  and checks its required scope in [`RpcAuthorization.ts`](../../apps/server/src/auth/RpcAuthorization.ts).
- **Secret references need `providers:manage`.** A request that names a secret for the server to
  read needs `providers:manage` on top of its method's scope, whether the reference is saved in
  settings or used once, as in a secret request answered with a reference. Typed values need only
  the method's scope. Clients hide the secret provider picker from sessions without it.
- **Project scripts need `orchestration:operate`.** The host runs a saved project script itself,
  on worktree creation and on settle, so saving one needs `orchestration:operate` on top of
  `settings:write`, whether it arrives in a settings patch or a project update.
- **Backward-compatible scope evolution.** Token exchange intersects requested scopes with the
  pairing grant, dropping retired/unknown names and failing before consuming a link if none remain.
  Stored grants are never expanded when scopes split. Auth responses preserve legacy `scopes`
  alongside exact `permissions` so older clients and servers stay compatible.

## Non-standard principals

- **Guest links are not sessions.** [GuestShareService](../../apps/server/src/guest/GuestShareService.ts)
  issues HMAC tokens bound to one share in the thread projection—never `SessionStore` rows—so no
  RPC, WebSocket, or MCP route can accept one. Closing, replacing, or archiving the share revokes
  every token. Guest routes also require T3 Connect to still serve the link's hostname (never rely
  on the request `Host` header alone).
- **MCP clients (`mcp-client`) are a separate audience.** Outside agents authenticate on `/mcp` via
  PKCE OAuth ([McpOAuth](../../apps/server/src/auth/McpOAuth.ts)), with stateless client
  registration so unauthenticated callers cannot grow server state. Users grant read-only access or
  a runtime-mode ceiling rather than raw scopes. Every non-`/mcp` HTTP and WebSocket route rejects
  `mcp-client` sessions (except the read-only thread relay and client-pairing routes restricted to
  [peer links](./05_remote.md#peer-links)). Every MCP tool must statically declare its access level in
  [`McpToolAccess.ts`](../../apps/server/src/mcp/McpToolAccess.ts), and thread-only tools must still
  refuse outside callers in handlers—hiding from tool listings is only discovery. A workflow run
  picks its own modes, so only a caller at the broadest mode a thread may run in here (full access,
  or an administrator's ceiling below it) can start or change runs, change what workflows store, or
  read webhook paths. Narrower callers can still read runs.
- **A project's worktree layout commands run only as a person approved them.** The commands come
  from the project folder's `t3.json` and run as the server's OS user, so each runs only after a
  client session holding `terminal:operate` approved its exact text for that project.
  [`TaskFolders`](../../apps/server/src/workspace/TaskFolders.ts) is the only place they run and
  checks the approval, managed policy, and who asked at every run. Recording an approval is a
  client RPC only: `t3code/no-layout-command-approval-writes` keeps the write side out of every
  other module, MCP tools included. For an agent's own worktree request, a thread below Full access
  gets neither these commands nor the project's setup script, approved or not. The asking thread's
  modes are read when each is about to run, a thread recorded above the administrator's
  `maxRuntimeMode` is not in Full access, and neither is an asking thread that can no longer be
  read. A command that waited for another one's turn is checked again, who asked, file and
  approval, before it starts; one refused then ran nothing, so the project's `remove` does not run
  for it either.
- **A repository's push hooks run for an agent below Full access only as a person approved
  them.** `pull_request_create` pushes as the server's OS user, and Git would run the checkout's
  `pre-push` and `reference-transaction` hooks, which the agent may have written. By the rule
  above for who is in Full access, a thread below it gets every Git command of that call with
  hooks off (`GitVcsDriver.RepositoryHooks`), except the push itself once a person approved the
  hooks by a digest of their contents. Hooks are the files in the hooks directory and the ones
  Git's configuration defines (`hook.<name>.command` with `hook.<name>.event`, which Git 2.54 and
  later run, read from every configuration file Git reads and whatever those include). Off means
  `-c core.hooksPath=/dev/null` on the command line, which every supported Git honors, and
  `hook.<name>.enabled=false` for each configured hook. The driver reads the hooks again as its
  last step before starting that push. If they are not the approved ones, nothing is pushed and
  the tool fails saying so, and the next call asks about the hooks as they are now; if none is
  left to run, the push goes ahead with hooks off. A hook file or a setting that cannot be read (anything but a
  missing file) fails the push: unknown never counts as no hook.
  The approved push gets a hooks directory of its own for as long as it runs, made under
  `push-hooks` in the server's state directory (outside every checkout, and not the system temp
  directory), holding one launcher per approved hook that starts the hook by its own path (so
  husky's `$0`-relative lookups still work); a file that appears among the repository's hooks
  during the push is not run, and every configured hook but the approved ones is disabled. Git
  skips a hook file it may not execute and pushes without it, so before Git starts the driver
  writes one more script there the same way and runs it. Unless that script ran and exited 0
  (the directory is on a `noexec` mount, the run was refused, or it did not end in time), nothing
  is pushed and the tool says the hooks could not be started. That is checked for the launchers
  only: a hook the launcher cannot start in turn fails the push in Git, as any failing hook does.
  Windows has no such permission and is not checked. The digest covers what it names and no more: each configured
  hook's name, command and the points of the push that start it, each hook file Git starts and, where that file is the shim husky 9
  and Vite+ install (`. "$(dirname "$0")/h"`), the runner `h` beside it and the script of the
  hook's name one directory up, such as `.husky/pre-push`. A named file edited after that last
  read and before Git starts it runs as edited, as does a configured hook added in that time.
  Only hooks are limited: other programs Git's configuration can name for a push, such as
  `core.sshCommand`, a credential helper or a remote helper, run as configured.
  The hooks are asked about in the same request as the push itself, described next.
  What those files go on to run, such as a package script or a file they source, is not part of
  the digest, so an approval is for the named files and not for everything the push executes.
- **Below Full access, a tool that acts outside its thread runs only once a person approved that
  call.** The provider adapters pre-approve T3 Code's own tools in every mode, so the server is
  what holds them to the thread's mode. A tool declared with
  [`McpToolAccess.actsOutsideThread`](../../apps/server/src/mcp/McpToolAccess.ts) (the forge
  writes of the pull-request and issue toolkits) first checks its arguments and resolves what
  they name, doing nothing yet; then, for a caller not in Full access by the rule above, the
  wrapper asks the person what will be done to what. The server writes the sentence. A name in
  it that the server did not write (a branch, a remote and its URL, a hook file or command, an
  issue key that is not shaped like one, the state `set_issue_state` was given) goes in with
  `McpToolAccess.quoted`: in quotation marks, on one line, cut to a fixed length, with any
  character a screen would hide (controls, format characters such as direction overrides and
  zero-width spaces, marks Unicode says to draw as nothing, every space but U+0020) written
  out as its code point. Numbers, commit ids
  and the repository and host a target resolved to go in as they are. Every field then passes
  through the same hidden-character and length check on its way out, whatever the handler did
  with it, so a value shown is always data inside the sentence and never more of the sentence.
  What an update, a comment or a review says is not shown: the request names the action and
  its target. It asks by MCP elicitation
  ([`McpClientInput`](../../apps/server/src/mcp/McpClientInput.ts)): a sessionless client is
  answered with the request and calls the tool again with the reply, so everything before the
  approval must be safe to run from the start twice. The request's state is the tool and a
  digest of its arguments and of everything they resolved to, shown or not
  (`OutsideAction.binds` carries what the words do not hold whole), and an answer counts only
  for that state, so a call that differs in any of it asks again. Once the answer is read the
  wrapper resolves everything a second time and runs that second reading, and only if its
  state is the approved one: however long the person took, and whichever call brought their
  answer, what runs was read after they answered. The rule for a handler: what
  the action depends on is resolved before the question and is part of that state, and the
  action then uses what was resolved. Where it has to read something again, it compares with
  what was asked and does nothing when they differ.
  `pull_request_create` is the case with the most to read. `GitManager.pullRequestOpening`
  reads the branch, the commit at its tip, the base, whether a push is needed, the remote and
  branch it goes to with every address the remote pushes to (shown and compared without the
  login, query or fragment a URL may carry), the branch on its remote the pull request is of
  when nothing is pushed, and the hooks a push would run, all with repository hooks off, and
  reads the hooks only when there is a push. The question names these (a private pull
  request's push is named as going to the repository's private companion, which the host
  makes only when the push is under way). `createPullRequest` given that reading back reads
  the checkout again and fails without pushing if any of it differs. The driver then checks,
  as its last step before Git starts, that the branch is at the approved commit and that the
  remote still pushes to the approved addresses and branch, and sends that commit by its id;
  it refuses a push Git would have to pick the destination of, and does not report a branch
  as already pushed unless it is at that commit. No push is made when none was approved, a
  private push goes only to a remote that pushes to the companion alone, the pull request is
  opened against the approved base, and one already open for the branch is returned as it
  is. A remote's address changed in the moment between that last check and Git starting is
  not caught. Which repository the host's own tool opens the pull request in is the host's
  configuration and is not read beforehand; the question names the project's repository and
  host.
  An update resolves each reviewer's name before the question, so a name nobody has ends the
  call before anything is written, and who it resolved to is part of the state. A review's
  line comments are placed in the diff before the question, and those placements are part of
  the state. `ci_rerun` names the pull request; which of its checks have failed is read when
  it runs.
  A stack merge names each layer it would merge with the head it is pinned to, and those
  numbers and heads are part of the state; the host is given the same list and refuses if the
  stack is not exactly that.
  The approval is the person's answer in the app, not the client's reply. The Claude and Codex
  adapters never answer a request T3 Code's own tool made, whatever the turn's runtime mode and
  whatever was allowed for the session. The request is kept with the thread's MCP session under
  an id of its own; the adapter, which receives the person's pending-request response, leaves
  the answer with the thread's requests that ask that message (each message ends with the start
  of its request's digest, so two requests never read alike); and the tool runs only when the
  request the reply names holds an approval for that state. That reads the request once and
  ends it. A reply of "accept" for a request the person did not approve, or one that is gone
  because the server restarted or the thread's session was replaced, does nothing: the tool
  fails saying T3 Code has no approval, and the next call asks again.
  A thread whose adapter does not pass on the person's answer, or whose client takes no
  elicitation, is asked by a request the server raises itself
  ([`McpThreadApproval`](../../apps/server/src/mcp/McpThreadApproval.ts)): the same
  `approval_request` item and runtime request an adapter would send for the question, recorded
  by an internal command and marked `recordOnly`, so every client shows and answers it as it
  does any other approval while the answer stays in the projection and nothing is delivered to
  the provider session. No provider client is trusted for it: the approval is the request's
  recorded decision, which only `runtime-request.respond` sets. A call waits a bounded time for
  the answer, since T3 Code does not set these clients' tool-call limits, and then returns
  `{ status: "awaiting_approval", next }` ([`awaitingApproval`](../../apps/server/src/mcp/awaitingApproval.ts)),
  which is part of each gated tool's result and not a failure: nothing was done, and clients
  show the call as still under way while its request waits. The request stays, kept with the
  thread's MCP session under its state, so the same call made again waits on it or finds its
  answer, and reading an answer ends it. It closes when the turn that asked ends or is
  restarted, and expires with a server restart like any pending request.
  An agent client that prompts for tool calls on its own leaves the tools in
  `T3_MCP_TOOLS_ASKED_BY_T3` to this request where the client names the call's MCP server and
  tool in fields of their own: Pi's extension (by the path of the bridge that registered the
  tool) and Kiro (`_meta.kiro.serverName` with `rawInput.tool_id`, answered with its one-time
  choice). A title is the model's wording and is never read for this, so the other ACP agents
  still show their own prompt before T3 Code's request.
  Only where there is nowhere to show a request is the call refused, with a message that says
  which: a thread with no turn running, and an MCP client from outside, which has no thread
  and so needs full access.
  `preview_act` asks through the same gate (`actsAsCallerAsking`) for an upload alone, and only
  for files that are not the thread's own: each path is resolved through links and compared
  with the thread's folders, resolved the same way, and with its attachments, and a path that
  cannot be resolved or placed is outside. The request names those files and the origin of the
  page they go to; those, every resolved path and the tab are its state. Like every gated
  call it is read again once the answer is in, so a page that moved on, or a path that now
  resolves elsewhere, sends nothing and asks again. What is sent is the resolved paths, not
  the ones given, so a link changed afterwards does not change the file. A page that
  navigates in the moment between that last read and the browser setting the files is not
  caught.
  A call bound for a linked environment is not sent below Full access. What it would do
  (the pull request "the branch" has there, the checkout's push and hooks) can only be
  resolved there, and that environment has no one to ask, so there is nothing concrete to
  show the person here. The agent is told so. From a Full access thread the call is forwarded
  with the agent's own modes like any other.
- **Peer-link client pairing.** Only a full-access peer link may mint a one-time client pairing on
  the linked environment (since full-access agents can already run `t3 auth pairing create`). The
  linked side enforces this itself, and the operation stays a human-triggered RPC/HTTP route rather
  than an MCP tool. The same route mints a code that links another environment at a chosen access
  level, and the linking side's RPC requires the caller to hold that level's scopes.

### Reusable dev credential

Web development servers can accept a fixed `T3CODE_DEV_AUTH_TOKEN` across worktrees and ports on one
hostname (see the [development runbook](../operations/00_development.md#reusable-dev-credential)). It
grants administrative access and is ignored by desktop and non-development servers.

Each environment hashes the value into its own database record and keeps independent SQLite state,
signing keys, and revocation state. Normal credentials always take precedence: a rejected normal
credential never falls back to the reusable dev credential.

## The environment is the filesystem boundary

Projects are organizational boundaries, not filesystem sandboxes. `filesystem:read` permits reading
any file the server's OS user can read (for example, artifacts an agent writes in a temp directory);
relative paths and writes remain constrained by
[`WorkspaceFileSystem.ts`](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

Signed asset URLs are bearer credentials for a single canonical file, rechecked by device/inode
identity on serve ([`AssetAccess.ts`](../../apps/server/src/assets/AssetAccess.ts)). They never
grant access to sibling files, with one exception: the URL of an HTML page opened from a workspace
also serves the files that page loads (styles, scripts, images, media, fonts and other pages) from
the page's own folder and the folders below it. It serves no hidden file, and no file that a link
in that folder points to outside it. Because `filesystem:read` is checked only at mint time, an
issued URL remains valid until it expires even if the session or grant is revoked.
