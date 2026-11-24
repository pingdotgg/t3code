# conn-files

Project files, search, signed asset URLs and the attachment store for the Conn Server. The
reference is the T3 server's `apps/server/src/workspace/*`, `assets/*` and `attachmentStore.ts`.
`conn-server` registers the methods in `src/methods/files.rs` and the routes in
`src/routes/assets.rs`.

## What it serves

| Method or route                         | Notes                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects.readFile`                     | 1 MiB cap, binary refused, `allowMissing`. A relative path stays in the root (symlinks resolved); an absolute path reads the host file in place, as T3 does |
| `projects.writeFile`                    | Only inside a project root or a thread worktree `git worktree list` names; no `.git`; existing ancestors resolved; `O_NOFOLLOW`                             |
| `projects.listEntries`                  | One folder (links inside the root only, ignored marks from `git check-ignore`), or the whole tree capped at 25,000                                          |
| `projects.listIgnoredFiles`             | `git ls-files --others --ignored --directory`, first 200                                                                                                    |
| `projects.searchEntries`                | Fuzzy path search (nucleo), `*`/`?`/`{a,b}` globs, `kind`, `imageOnly`; an exact relative path also in ignored nested worktrees                             |
| `projects.searchContents`               | ripgrep's searcher; literal or regex, case, whole word; 500 matches, 100 per file, 1.5 s budget                                                             |
| `filesystem.browse`, `getMetadata`      | As T3                                                                                                                                                       |
| `shell.openInEditor`                    | A server host has no desktop: always `ExternalLauncherCommandNotFoundError`; `availableEditors` is empty so clients hide it                                 |
| `assets.createUrl`                      | workspace and media files, drafts, attachments, project favicons, native app icons (always 404 here)                                                        |
| `assets.persistChatAttachments`         | `data:` URL images under ids derived from the message; the contract limits (`image/`, 10 MiB, 14,000,000-character data URL) checked before decoding      |
| `attachments.createUploadUrl`, `delete` | Pending uploads; delete removes pending ones only                                                                                                           |
| `GET /api/assets/<token>/<name>`        | Signed token is the credential. Streams with `Range`; HTML and SVG sandboxed; media pinned to device and inode                                              |
| `POST /api/attachments/upload/<token>`  | Streams to a `.part` file, publishes by hard link without replacement                                                                                       |

Nothing stays in memory between calls: no search index, no favicon cache. Each search walks the
tree again, bounded by 25,000 files and its time budget.

## State

- `<state-dir>/attachments/<id><.ext>`: one flat folder. Ids are `<thread>-<uuid>[-<ext>]`;
  uploads start as `pending-…`. The sweep removes pending uploads after 24 hours and `.part`
  files after an hour, at most every 15 minutes, when an upload URL is issued.
- `<state-dir>/secrets/asset-signing-key`: 32 random bytes (0600) that sign asset and upload
  URLs. Removing it invalidates every issued URL.
- **Internal files** are never served by a file method, listing, search or asset URL
  (`paths::InternalPaths`). The base is the T3 server's set (`auth/serverInternalPaths.ts`):
  `secrets/`, files directly in the state folder whose name holds `.sqlite`
  (`engine.sqlite`, its journal, `server-owner.sqlite`), and `/dev/fd`. We add `auth.json`
  (session and pairing-link hashes, which T3 keeps inside its refused SQLite file) and
  `terminals/` (terminal scrollback). The rest of the state folder reads like any host file,
  as in T3; that includes thread worktrees under `<state-dir>/worktrees`.
- Beyond T3, listings and searches (`listEntries`, `listIgnoredFiles`, `searchEntries`,
  `searchContents`) refuse a root inside the internal set (`workspace_root_not_found`) and
  skip internal files during the walk. T3 does not check there; we do because the signing key
  mints asset URLs that work without a session. The review file read checks the set as T3's
  does.

## For providers and the engine

```rust
// Attachment id (ChatAttachment.id) -> stored file. None: invalid id or missing file.
files.attachments.resolve(&id) -> Option<AttachmentFile { path, byte_length, extension, mime_type }>
// When a message is accepted: copy a pending upload to a thread id; returns the attachment
// the message should keep. Non-pending attachments come back unchanged.
files.attachments.claim(&thread_id, &attachment) -> Result<ChatAttachment, String>
// The message was refused after claiming: remove the copies.
files.attachments.release(&claimed)
```

`Files` is in `Deps::files`. Both functions block; call them on `spawn_blocking`.

## Not done

- **Sending attachments to the agent.** Uploads, previews and claims work, and the
  descriptor advertises `attachmentUploads` and `fileAttachments`: the message that sends an
  upload claims it (`crates/conn-server/src/host.rs`). Whether each provider passes every file
  kind on to its CLI is in that provider crate's README.
- `tool-output-image` assets (turn item outputs are not stored yet), `github-media` (needs
  source control credentials; answers "not supported"), native app icons (desktop only).
- Extracted text of uploaded documents (`DocumentText`), `.t3` project file icons.
- Search quality differs from fff: no typo tolerance, no frecency.

## Check

`cargo test -p conn-files` covers every path escape (`..`, absolute paths, links out, `.git`,
the state folder). `cargo run --release -p conn-files --example search_memory -- <dir>`
prints what a listing and both searches find and take. The `ts-files` and `rust-files`
recorder scenarios drive the real web client against each server (`fixtures/README.md`).

HTML publication omits T3's optional browser-measured heights and recovery of successful
results missing from provider transcripts. HTML pattern whitespace follows Rust's Unicode rules.

MCP App documents are thread attachments with the `-html` suffix, capped at 5 MiB. Captures
keep the resource's filtered CSP and permissions. Inline assets add T3's cookie and theme
bootstraps, generated by `tools/gen-mcp-apps.mjs`; the MCP parity check holds them to T3.
