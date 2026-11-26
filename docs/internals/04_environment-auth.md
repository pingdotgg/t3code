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
  what holds them to the thread's mode: the forge writes of the pull-request and issue toolkits
  ([`McpToolAccess.actsOutsideThread`](../../apps/server/src/mcp/McpToolAccess.ts)) and a
  `preview_act` upload of a file that is not the thread's own (`actsAsCallerAsking`).
  - **The approval is the server's record, never a client's reply.** The request is raised by
    the server in the calling thread
    ([`McpThreadApproval`](../../apps/server/src/mcp/McpThreadApproval.ts)) and the orchestrator
    records the answer. The same request is sent to the provider's client as an MCP elicitation
    only so that the client lets the call wait; an adapter that says it holds these
    (`holdsApprovalRequests`) keeps it open until the request has ended, never answers it from
    a mode or an earlier grant, and shows no card of its own. Claude and Codex know T3 Code's
    elicitation by its server together with the request id, or the question's words where no
    id is passed on. ACP names no server on an elicitation: its adapter goes by the id or the
    words, and rules one out when it is tied to a tool call the agent said belongs to another
    server.
  - **An approval is for one resolved action, and is used once.** The request's state is the
    tool, its arguments and everything they resolved to, shown or not (`OutsideAction.binds`).
    After the answer the wrapper resolves everything again and runs that second reading only
    if its state is the approved one. So a handler resolves all the action depends on before
    the question, acts on what was resolved, and where it must read something again compares
    it and does nothing when it differs. Calls that ask the same thing at once wait on one
    request; its approval is taken by exactly one of them, and the others ask again. The same
    call made again in the same turn, after its client cut the first off, finds that request.
  - **What the person reads is the server's sentence.** A name the server did not write goes
    in through `McpToolAccess.quoted`, and every field passes the same hidden-character and
    length check on its way out. An action too long to show in full is refused, not asked
    about. What an update, a comment or a review says is not shown.
  - **The request lives and ends with the turn that asked.** That turn ending or being
    interrupted cancels it; archiving the thread declines it; a server restart expires it, and
    an answer given to it afterwards lets nothing through. A client of the app disconnecting
    changes nothing. A thread keeps a bounded number of requests: one more than that, with
    every kept one still waiting for the person, is refused, so no card is left that no call
    waits on.
  - **Nothing times the person; the server times the work.** A client whose adapter holds
    the elicitation waits as long as the person takes. Any other gets
    `{ status: "awaiting_approval", next }`
    ([`awaitingApproval`](../../apps/server/src/mcp/awaitingApproval.ts)) after a bounded wait,
    which is a result and not a failure, and the same call made again waits on the same
    request. Claude Code's tool-call clock runs while an elicitation is open, so T3 Code's
    server is registered there with the longest limit a timer holds, and the bound on a hung
    call is the server's own: [`McpToolDeadline`](../../apps/server/src/mcp/McpToolDeadline.ts)
    ends any T3 tool call that has worked for its limit, not counting time spent waiting on a
    person, and interrupts the handler. What the handler had already sent to a remote, a forge
    or a linked environment by then is not undone.
  - **A sessionless client is sent the elicitation as the call's answer and calls again**, so
    everything a gated handler does before the question must be safe to run from the start
    twice.
  - **`pull_request_create` approves the push and the pull request together.**
    `GitManager.pullRequestOpening` reads what would be done with repository hooks off, and
    `createPullRequest` given that reading back does that and nothing else: it fails before
    pushing if the checkout no longer matches, the driver compares commit, remote, branch and
    push addresses as its last step before Git starts (before it reports anything as already
    pushed, too), and after an approved push the pull request's head is the branch that was
    approved, never one read from the checkout again. A push that was made stands when the
    pull request then cannot be opened, and the result says so. Not caught: a remote's
    address changed between that last check and Git starting, and which repository the host's
    own tool opens the pull request in.
  - **A call bound for a linked environment is described there and approved here.** Only that
    environment can resolve it, so below Full access it is sent as `T3-Outside-Action:
    describe`, which does nothing, and again as `approved <digest>`, which acts only if the
    call still resolves to that digest. Both headers are read only from a linked client. An
    environment that does not answer `T3-Outside-Actions: describe` is sent neither, since it
    would act unasked; the capability is asked for again before a call is refused for it. A
    link paired below full access still starts no such work there.
  - **An agent client that prompts for tool calls itself** leaves the tools in
    `T3_MCP_TOOLS_ASKED_BY_T3` to this request only where it names the call's MCP server and
    tool in fields of their own (Pi, Kiro). A title is the model's wording and is never read
    for this.
  - **An upload sends the resolved paths**, not the ones given, to the origin the person was
    shown. A page that navigates between the last read and the browser setting the files is
    not caught.
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
