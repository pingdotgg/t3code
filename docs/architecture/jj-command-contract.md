# jj command contract

Status: Phases 0-5 implemented; remote publishing begins in Phase 6.

## Compatibility

T3 Code's minimum supported Jujutsu version is `0.42.0`.

The floor is enforced by `inspectJjVersion()` in `packages/shared/src/jjCli.ts`. Source-control discovery reports older or unparseable versions as `unsupported` with an actionable minimum-version message.

The real-CLI contract runs against:

- `jj-cli@0.42.0`, the compatibility floor;
- the latest `jj-cli` release available to the installer;
- Ubuntu, macOS, and Windows.

The matrix lives in `.github/workflows/jj-phase-zero.yml`. Run the same smoke test locally with:

```sh
pnpm test:jj-phase-zero
```

## Machine-output rules

All commands must:

- pass arguments as an argv array, never through a shell command string;
- use `--color=never` and `--no-pager`;
- treat stdout as bounded untrusted input;
- treat stderr as diagnostic input only, never as repository data.

Commands returning machine metadata must additionally:

- provide an explicit template;
- emit one JSON value per line;
- decode every metadata line with `JSON.parse`.

Git-format patch commands and `jj git remote list` are not machine-metadata commands. Patch output
remains bounded Git-format text, while remote-list output uses jj's documented non-template line
format until jj provides structured template output.

The canonical templates and argv builders live in `packages/shared/src/jjCli.ts`:

- `JJ_REVISION_JSON_TEMPLATE` for status/revision data;
- `JJ_CHANGED_FILE_JSON_TEMPLATE` for changed paths;
- `JJ_BOOKMARK_JSON_TEMPLATE` for local and remote bookmarks;
- `JJ_WORKSPACE_JSON_TEMPLATE` for workspace identity and targets;
- `JJ_OPERATION_JSON_TEMPLATE` for operation IDs and metadata.

Production process/repository support lives in `apps/server/src/vcs/JjProcess.ts` and
`apps/server/src/vcs/JjVcsDriver.ts`. Automatic detection prefers `.jj` over `.git` in
colocated repositories.

Phase 3 status reads explicitly snapshot first, then expose workspace revision metadata, changed
files, content conflicts, local/remote bookmarks, tracked-default divergence, and bounded
Git-format review patches. jj status keeps `refName` and `publishRef` null: a bookmark pointing at
`@` is not treated as current or selected for publishing.

`json()` performs escaping. Newlines, tabs, quotes, spaces, and Unicode therefore cannot break record boundaries. Do not replace these templates with parsing of default `jj status`, `jj log`, or graph output.

## Command mapping

Commands below omit the standard `--color=never --no-pager` prefix and repository path selection.

| Product intent             | jj command                                                 | Data contract                                                       |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| Discover version           | `jj --version`                                             | Parse with `inspectJjVersion()`                                     |
| Detect workspace root      | `jj workspace root`                                        | One absolute path                                                   |
| Initialize                 | `jj git init --colocate <destination>`                     | Exit status; verify `.jj` and `.git`                                |
| Clone                      | `jj git clone --colocate <source> <destination>`           | Exit status; verify `.jj` and `.git`                                |
| Snapshot filesystem        | `jj util snapshot`                                         | Exit status, followed by revision/operation query                   |
| Read current revision      | `jj log --no-graph -r @ -T <revision-json>`                | One `JjRevisionRecord` JSON line                                    |
| Read arbitrary revision    | `jj log --no-graph -r <revision> -T <revision-json>`       | Exactly one `JjRevisionRecord`                                      |
| Read changed files         | `jj log --no-graph -r <revision> -T <changed-file-json>`   | Zero or more `JjChangedFileRecord` lines                            |
| Read patch                 | `jj diff --git -r <revision>`                              | Bounded Git-format patch, not structured metadata                   |
| Read range patch           | `jj diff --git --from <base> --to <target>`                | Bounded Git-format patch                                            |
| List files                 | `jj file list -r <revision> -T 'json(path) ++ "\\n"'`      | One JSON path per line                                              |
| Filter files               | `jj file list -r @ -T <file-json> <root-file filesets...>` | Returned exact paths are tracked/non-ignored                        |
| List bookmarks             | `jj bookmark list --all-remotes -T <bookmark-json>`        | One serialized `CommitRef` per line                                 |
| Create bookmark            | `jj bookmark create <quoted-symbol> -r <revision>`         | Exit status plus invalid-ref warning check                          |
| Move bookmark              | `jj bookmark set <quoted-symbol> -r <revision>`            | Exit status plus conflict/warning check                             |
| Track remote bookmark      | `jj bookmark track <name> --remote <remote>`               | Exit status                                                         |
| List workspaces            | `jj workspace list -T <workspace-json>`                    | One serialized `WorkspaceRef` per line                              |
| Create workspace           | `jj workspace add <path> --name <name> -r <base>`          | Exit status; confirm through workspace list                         |
| Repair stale workspace     | `jj workspace update-stale`                                | Exit status; then reread revision                                   |
| Forget workspace           | `jj workspace forget <name>`                               | Exit status before directory removal                                |
| Describe change            | `jj describe -m <message>`                                 | Exit status; then reread revision                                   |
| Finalize all files         | `jj commit -m <message>`                                   | Record `@` before and `@-`/`@` after                                |
| Finalize selected files    | `jj commit -m <message> <root-file filesets...>`           | Selected files remain in finalized revision; others move to new `@` |
| Start change               | `jj new <base>`                                            | Exit status; then reread `@`                                        |
| Edit existing change       | `jj edit <revision>`                                       | Explicit-only operation; never implicit checkout behavior           |
| Restore checkpoint content | `jj restore --from <checkpoint-commit> --into @`           | Reread `@`; restore description separately                          |
| Read current operation     | `jj op log --no-graph -n 1 -T <operation-json>`            | Exactly one serialized operation                                    |
| Garbage collect            | `jj util gc --expire now`                                  | Used by retention tests, not normal workflow                        |
| List remotes               | `jj git remote list`                                       | Decode documented line format until jj provides template output     |
| Add remote                 | `jj git remote add <name> <url>`                           | Exit status; redact URL credentials                                 |
| Fetch                      | `jj git fetch --remote <remote>`                           | Exit status; then reread bookmarks                                  |
| Push one bookmark          | `jj git push --remote <remote> --bookmark <name>`          | Exit status; never push all bookmarks                               |

## Thread workspace lifecycle

Thread workspace names are `t3code-` plus the first 20 hexadecimal characters of the SHA-256 digest
of the thread ID. The mapping is deterministic, filesystem-safe, and independent of user-selected
bookmark names.

Creation resolves and stores the requested base revision before `jj workspace add`. A successful
result is accepted only after workspace metadata and the new working-copy revision are reread. The
persisted identity contains the workspace name and path, current commit/change IDs, base
commit/change IDs, and the optional publish bookmark.

Reconnect validates the path's current workspace name. A stale working copy is logged before
`jj workspace update-stale` runs, then its revision is reread. A missing directory with retained jj
metadata is repaired by forgetting the missing workspace and recreating it at the persisted base.
Non-empty paths owned by another or unknown workspace are never replaced.

Removal validates ownership, runs `jj workspace forget <name>`, and only then recursively removes
the workspace directory. Missing metadata and missing directories are idempotent; ownership
mismatches fail without deleting files.

Bookmark/revision names that enter revset positions must use `quoteJjSymbol()`. Exact file arguments
use `quoteJjRootFileFileset()`, which rejects absolute or parent-traversing paths and produces a
`root-file:` fileset with template-language string quoting.

## Special-character results

The executable smoke test covers:

- repository and workspace paths containing spaces and Unicode;
- file paths containing spaces and Unicode on every OS;
- file paths containing tabs and newlines where the host filesystem permits them;
- multiline descriptions containing tabs and Unicode;
- Unicode bookmark names that export to the colocated Git repository;
- spaces, tabs, and newlines in jj bookmark names.

jj can represent quoted bookmark names containing spaces or control characters, but Git refs cannot. In a colocated repository, jj may return exit code `0` while warning that export failed. T3 Code therefore inspects stderr even on successful bookmark mutations and classifies this case as `invalid-ref`.

## Error and condition classification

| Condition                       | Source                           | Classification         |
| ------------------------------- | -------------------------------- | ---------------------- |
| Missing `jj` executable         | Process spawn failure            | `VcsProcessSpawnError` |
| Directory outside jj repository | Non-zero stderr                  | `not-repository`       |
| Stale workspace                 | Non-zero stderr                  | `stale-workspace`      |
| Missing/ambiguous revision      | Non-zero stderr                  | `unresolved-revision`  |
| Conflicted bookmark             | Non-zero stderr or bookmark JSON | `bookmark-conflict`    |
| Content conflict                | `JjRevisionRecord.conflict`      | `content-conflict`     |
| Authentication failure          | Non-zero stderr                  | `authentication`       |
| Remote safety rejection         | Non-zero stderr                  | `push-rejected`        |
| Git-incompatible bookmark       | Success or failure stderr        | `invalid-ref`          |
| Unknown non-zero result         | Non-zero stderr                  | `command-failed`       |

Content conflicts are repository state, not necessarily command failure. They must be decoded from the revision JSON rather than inferred from exit status.

Classification is structural and redacted: errors retain kind, operation, command, exit code, stderr length, and truncation state. They do not retain stderr or argv secrets.

## Checkpoint decision

A jj checkpoint record contains:

```ts
interface JjCheckpointMetadata {
  readonly operationId: string;
  readonly workspaceName: string;
  readonly commitId: string;
  readonly changeId: string;
  readonly description: string;
}
```

Capture sequence:

1. Run `jj util snapshot`.
2. Read `@` with the revision JSON template.
3. Read the current operation with the operation JSON template.
4. Persist the metadata atomically with the T3 Code checkpoint.

Restore sequence:

1. Resolve the recorded commit ID after a fresh process start.
2. Run `jj restore --from <commitId> --into @` in the recorded workspace.
3. Restore the recorded description with `jj describe -m <description>`.
4. Verify the resulting revision and files.

Do not use `jj op restore`. It changes repository-wide operation state and can affect unrelated workspaces.

The smoke test proves the recorded commit remains resolvable after process restart and `jj util gc --expire now`, then proves restore leaves a sibling workspace and publish bookmark unchanged.

Retention promise: checkpoint revisions are retained while their operation remains in jj's operation log. T3 Code must not abandon checkpoint operations during the product checkpoint retention window. External `jj op abandon` can invalidate that promise and must produce an expired-checkpoint error, never a fallback repository-wide restore.

## Implemented evidence

- Pure contract tests: `packages/shared/src/jjCli.test.ts`
- Process error tests: `apps/server/src/vcs/VcsProcess.test.ts`
- Discovery version test: `apps/server/src/sourceControl/SourceControlDiscovery.test.ts`
- Real CLI smoke: `scripts/jj-phase-zero-smoke.ts`
- Platform/version matrix: `.github/workflows/jj-phase-zero.yml`
