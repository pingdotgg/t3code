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
  its target. A question too long to show in full is not asked, and the call is refused.
  The person is asked in the calling thread, by a request the server raises itself
  ([`McpThreadApproval`](../../apps/server/src/mcp/McpThreadApproval.ts)) and whose answer the
  orchestrator records, so the approval never depends on what a provider's client says the
  person chose. The request's state is the tool and a digest of its arguments and of
  everything they resolved to, shown or not (`OutsideAction.binds` carries what the words do
  not hold whole), and an answer counts only for that state. Once the answer is read the
  wrapper resolves everything a second time and runs that second reading, and only if its
  state is the approved one: however long the person took, what runs was read after they
  answered. The rule for a handler: what the action depends on is resolved before the
  question and is part of that state, and the action then uses what was resolved. Where it
  has to read something again, it compares with what was asked and does nothing when they
  differ.
  `pull_request_create` is the case with the most to read. `GitManager.pullRequestOpening`
  reads the branch, the commit at its tip, the base, whether a push is needed, the remote and
  branch it goes to with every address the remote pushes to (shown and compared without the
  login, query or fragment a URL may carry), the branch on its remote the pull request is of
  when nothing is pushed and the commit that branch is at as last fetched, and the hooks a
  push would run, all with repository hooks off, and
  reads the hooks only when there is a push. The question names these (a private pull
  request's push is named as going to the repository's private companion, which the host
  makes only when the push is under way). `createPullRequest` given that reading back reads
  the checkout again and fails without pushing if any of it differs. The driver then checks,
  as its last step before Git starts, that the branch is at the approved commit and that the
  remote still pushes to the approved addresses and branch, and sends that commit by its id;
  it refuses a push Git would have to pick the destination of, and does not report a branch
  as already pushed unless it is at that commit. An approved push is made with submodule
  recursion and tag following off, so it writes that one branch to that one remote whatever
  Git's configuration says. Every address a push writes to is shown whole, or the push is not
  asked about; a branch that tracks a local branch is not offered an opening without a push,
  since being level with that branch says nothing of the published one. No push
  is made when none was approved, a private push goes only to a remote that pushes to the
  companion alone (checked again as that push starts), the pull request is
  opened against the approved base, and one already open for the branch is returned as it
  is. A remote's address changed in the moment between that last check and Git starting is
  not caught. Which repository the host's own tool opens the pull request in is the host's
  configuration and is not read beforehand; the question names the project's repository and
  host.
  An update resolves each reviewer's name before the question, so a name nobody has ends the
  call before anything is written, and who it resolved to is part of the state. A review's
  line comments are placed in the diff before the question, and those placements are part of
  the state. `ci_rerun` names the checks it would rerun, and the host is asked to rerun
  exactly those: the service reads them again as it starts and does nothing when they are
  no longer that set. A review with line comments is sent pinned to the head its lines were
  placed on.
  A stack merge names each layer it would merge with the head it is pinned to, and those
  numbers and heads are part of the state; the host is given the same list and refuses if the
  stack is not exactly that.
  The call waits for the answer with no limit of its own, as Codex's app server waits on an
  MCP elicitation. So that the provider's client lets it wait, the request is also sent to
  that client as an MCP elicitation ([`McpClientInput`](../../apps/server/src/mcp/McpClientInput.ts))
  carrying the request's id, and the thread's adapter holds that elicitation open until the
  request has ended and then answers it as it ended. A client with a session is sent it while
  the call stays open. A sessionless one, as Claude Code is, is sent it as the call's answer
  and calls again with its reply, so everything before the question must be safe to run from
  the start twice. An adapter never answers one itself,
  whatever the turn's runtime mode and whatever was allowed for the session, and shows no
  card of its own for it. Codex stops its tool-call clock while an elicitation is open. Claude
  Code does not, and progress notifications do not extend its limit, so T3 Code's server is
  registered there with the longest tool-call limit a timer holds.
  The request is tied to the turn that asked. When that turn ends, is interrupted or gives
  way to another, the request is cancelled and the call returns saying nothing was done;
  archiving the thread declines it. A client of the app disconnecting changes nothing: the
  request is in the thread, and is shown again to whoever opens it. A server restart loses
  what the server kept in memory for it, so the request is expired at startup and an answer
  given to it lets nothing through. An approval is used once, by the call that asked or by
  the same call made again in the same turn after its client cut the first one off.
  Where the person cannot be asked this way, nothing is shown and the call is refused: a
  thread whose adapter does not hold T3 Code's requests or whose client takes no
  elicitation, and an MCP client from outside, which has no thread and so needs full access.
  A call bound for a linked environment acts on a checkout and a forge login that are there,
  so only that environment can say what it would do. Below Full access it is first sent as
  `T3-Outside-Action: describe`: the linked environment resolves the call as above, with
  repository hooks off, and answers with the request's digest and the words to show, doing
  nothing. The person is asked here, in the calling thread, with the linked environment
  named; the call then goes again as `approved <digest>`, and the linked environment
  resolves it once more and acts only if it is still that request. Both headers are read
  only from a linked client. An environment that does not answer `T3-Outside-Actions:
  describe` is never sent either step, since it would act on the call unasked, and the agent
  is told so. A link paired below full access still starts no such work
  there. From a Full access thread the call is forwarded with the agent's own modes like any
  other.
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
