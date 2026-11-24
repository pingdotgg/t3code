//! Commit preparation uses a scratch index; only the final commit changes the real index.
use crate::{
    VcsError, VcsResult,
    process::{GitCommand, OnLimit, ProcessError},
    repo,
};
use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    os::unix::ffi::OsStrExt,
    path::Path,
    time::Duration,
};

#[derive(Debug)]
pub struct Context {
    pub summary: String,
    pub patch: String,
}

struct Scratch(std::path::PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let path = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(path);
        });
    }
}

fn command(
    cwd: &Path,
    args: impl IntoIterator<Item = impl Into<std::ffi::OsString>>,
) -> GitCommand {
    GitCommand::new("GitVcsDriver.commit", cwd, args).timeout(Duration::from_secs(300))
}

fn indexed(command: GitCommand, index: &Path, alternates: &str) -> GitCommand {
    let objects = index.with_file_name("objects");
    command
        .env("GIT_INDEX_FILE", index)
        .env("GIT_OBJECT_DIRECTORY", &objects)
        .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternates)
}

fn literal(path: impl AsRef<OsStr>) -> OsString {
    let mut spec = OsString::from(":(top,literal)");
    spec.push(path);
    spec
}

fn paths(paths: &[String]) -> Vec<OsString> {
    paths.iter().map(literal).collect()
}

/// `git diff` over the whole repository: a project's `diff.relative` would limit it to the cwd.
fn diff<'a>(args: impl IntoIterator<Item = &'a str>) -> Vec<OsString> {
    ["-c", "diff.relative=false", "diff"]
        .into_iter()
        .chain(args)
        .map(Into::into)
        .collect()
}

async fn operation_in_progress(cwd: &Path) -> VcsResult<Option<&'static str>> {
    for (name, operation) in [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ] {
        if repo::ref_exists(cwd, name).await? {
            return Ok(Some(operation));
        }
    }
    let path = command(cwd, ["rev-parse", "--git-path", "sequencer"])
        .text()
        .await?;
    let path = cwd.join(path.trim());
    if tokio::task::spawn_blocking(move || path.exists())
        .await
        .unwrap_or(false)
    {
        return Ok(Some("cherry-pick or revert"));
    }
    Ok(None)
}

/// Appends `chunk` to `partial` and hands `each` every non-empty record that `separator` ends.
fn split_records(partial: &mut Vec<u8>, chunk: &[u8], separator: u8, each: &mut impl FnMut(&[u8])) {
    let mut pieces = chunk.split(|&byte| byte == separator);
    let mut piece = pieces.next().unwrap_or_default();
    for next in pieces {
        partial.extend_from_slice(piece);
        if !partial.is_empty() {
            each(partial);
            partial.clear();
        }
        piece = next;
    }
    partial.extend_from_slice(piece);
}

/// Runs `command` and hands each non-empty record of its output, ended by `separator`, to
/// `each`. It holds one record at a time, so long output needs no limit. A failed run still
/// hands over everything it printed.
async fn each_record(
    command: GitCommand,
    separator: u8,
    mut each: impl FnMut(&[u8]) + Send,
) -> Result<(), ProcessError> {
    let mut partial = Vec::new();
    let scanned = command
        .scan(&mut |chunk: &[u8]| split_records(&mut partial, chunk, separator, &mut each))
        .await;
    if !partial.is_empty() {
        each(&partial);
    }
    scanned.map(drop)
}

/// The path and 1-based line of a `git diff --check` report of a leftover conflict marker.
fn marker_report(line: &[u8]) -> Option<(&[u8], usize)> {
    let rest = line.strip_suffix(b": leftover conflict marker")?;
    let mut parts = rest.rsplitn(2, |&byte| byte == b':');
    let number = parts.next()?;
    let path = parts.next()?;
    if !number.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some((path, std::str::from_utf8(number).ok()?.parse().ok()?))
}

/// Adds `git diff --check`'s leftover-marker reports for `files` to `reports`. `--check` exits
/// 2 when it reports a problem.
async fn marker_reports(
    command: GitCommand,
    files: &HashMap<&[u8], usize>,
    reports: &mut HashMap<usize, HashSet<usize>>,
) -> Result<(), ProcessError> {
    each_record(command, b'\n', |line| {
        if let Some((path, number)) = marker_report(line)
            && let Some(&file) = files.get(path)
        {
            reports.entry(file).or_default().insert(number);
        }
    })
    .await
}

/// Splits `paths` into runs whose pathspecs stay well under the platform's argument limit.
fn path_batches(paths: &[OsString]) -> Vec<&[OsString]> {
    const BUDGET: usize = 128 * 1024;
    let mut batches = Vec::new();
    let (mut start, mut size) = (0, 0);
    for (n, path) in paths.iter().enumerate() {
        // The pathspec prefix, its NUL and its argv pointer.
        let cost = path.len() + 24;
        if n > start && size + cost > BUDGET {
            batches.push(&paths[start..n]);
            (start, size) = (n, 0);
        }
        size += cost;
    }
    if start < paths.len() {
        batches.push(&paths[start..]);
    }
    batches
}

async fn stage(
    cwd: &Path,
    selected: Option<&[String]>,
    index: Option<(&Path, &str)>,
) -> VcsResult<()> {
    let run = |args: Vec<OsString>| {
        let c = command(cwd, args);
        if let Some((index, alternates)) = index {
            indexed(c, index, alternates)
        } else {
            c
        }
    };
    let selected = selected.filter(|paths| !paths.is_empty());
    if let Some(selected) = selected {
        if index.is_none()
            && let Some(operation) = operation_in_progress(cwd).await?
        {
            return Err(VcsError::invalid(
                "GitVcsDriver.commit",
                &cwd.to_string_lossy(),
                format!(
                    "Cannot commit selected files during a {operation}. Commit all files to finish the {operation}."
                ),
            ));
        }
        if index.is_some() {
            let head = repo::has_head_commit(cwd).await?;
            run(vec![
                "read-tree".into(),
                if head { "HEAD" } else { "--empty" }.into(),
            ])
            .run()
            .await?;
        } else {
            let unmerged = run(diff(["--cached", "--name-only", "--diff-filter=U", "-z"]))
                .text()
                .await?;
            // Reset drops every conflict stage, so keep the index while an unselected file is
            // conflicted.
            if !unmerged
                .split('\0')
                .any(|p| !p.is_empty() && !selected.iter().any(|s| s == p))
            {
                run(vec!["reset".into(), "--quiet".into()]).run().await?;
            }
        }
    } else {
        // `add -A` marks unmerged paths resolved, so refuse while one still has conflict markers.
        let mut unmerged = Vec::new();
        each_record(
            run(diff(["--name-only", "--diff-filter=U", "-z"])),
            0,
            |file| unmerged.push(OsStr::from_bytes(file).to_owned()),
        )
        .await?;
        if !unmerged.is_empty() {
            let files: HashMap<&[u8], usize> = unmerged
                .iter()
                .enumerate()
                .map(|(n, file)| (file.as_bytes(), n))
                .collect();
            let mut reports: HashMap<usize, HashSet<usize>> = HashMap::new();
            // The whole tree, not T3's pathspec per unmerged path: thousands of paths pass the
            // argument limit. Reports for other files are ignored.
            let check = diff(["--check", "--no-color"]);
            match marker_reports(run(check), &files, &mut reports).await {
                Ok(()) | Err(ProcessError::Exit { code: 2, .. }) => {}
                // Another file can make Git die before it reports; check T3's paths instead.
                Err(ProcessError::Exit { .. }) => {
                    reports.clear();
                    for batch in path_batches(&unmerged) {
                        let mut check = diff(["--check", "--no-color", "--"]);
                        check.extend(batch.iter().map(literal));
                        match marker_reports(run(check), &files, &mut reports).await {
                            Ok(()) | Err(ProcessError::Exit { code: 2, .. }) => {}
                            Err(error) => return Err(error.into()),
                        }
                    }
                }
                Err(error) => return Err(error.into()),
            }
            let mut conflicted = Vec::new();
            if !reports.is_empty() {
                let empty_tree = run(vec![
                    "hash-object".into(),
                    "-t".into(),
                    "tree".into(),
                    "--stdin".into(),
                ])
                .stdin(Vec::new())
                .text()
                .await?;
                for (n, file) in unmerged.iter().enumerate() {
                    let Some(lines) = reports.get(&n) else {
                        continue;
                    };
                    // `--check` numbers lines after working-tree-encoding and clean filters; a
                    // diff from the empty tree prints that view, one added line per file line.
                    let mut args = diff([
                        "--no-color",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--text",
                        empty_tree.trim(),
                        "--",
                    ]);
                    args.push(literal(file));
                    let (mut in_hunk, mut line, mut opening, mut closing) =
                        (false, 0, false, false);
                    each_record(run(args), b'\n', |diff_line| {
                        if !in_hunk {
                            in_hunk = diff_line.starts_with(b"@@");
                            return;
                        }
                        let Some(content) = diff_line.strip_prefix(b"+") else {
                            return;
                        };
                        line += 1;
                        if lines.contains(&line) {
                            // Git also reports a lone "=======", which is valid content such
                            // as a heading underline.
                            match content.first() {
                                Some(b'<') => opening = true,
                                Some(b'>') => closing = true,
                                _ => {}
                            }
                        }
                    })
                    .await
                    .map_err(|_| {
                        VcsError::invalid(
                            "GitVcsDriver.commit.conflictMarkers",
                            &cwd.to_string_lossy(),
                            format!(
                                "Could not check {} for conflict markers.",
                                file.to_string_lossy()
                            ),
                        )
                    })?;
                    if opening && closing {
                        conflicted.push(file.to_string_lossy());
                    }
                }
            }
            if !conflicted.is_empty() {
                let files = conflicted.join(", ");
                return Err(VcsError::invalid(
                    "GitVcsDriver.commit",
                    &cwd.to_string_lossy(),
                    format!(
                        "Cannot commit with unresolved merge conflicts in {files}. Resolve them, then commit."
                    ),
                ));
            }
        }
    }
    let mut args = vec!["add".into(), "-A".into()];
    if index.is_some() {
        args.splice(0..0, ["-c".into(), "core.splitIndex=false".into()]);
    }
    if let Some(selected) = selected {
        args.push("--".into());
        args.extend(paths(selected));
    }
    run(args).run().await?;
    Ok(())
}

pub async fn prepare_context(
    cwd: &Path,
    selected: Option<&[String]>,
    include_patch: bool,
) -> VcsResult<Option<Context>> {
    let index = command(
        cwd,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )
    .text()
    .await?;
    let objects = command(
        cwd,
        [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "objects",
        ],
    )
    .text()
    .await?;
    let counts = command(cwd, ["count-objects", "-v"]).text().await?;
    let alternates = std::iter::once(objects.trim())
        .chain(
            counts
                .lines()
                .filter_map(|line| line.strip_prefix("alternate: ")),
        )
        .map(|path| {
            if path.starts_with('"') {
                path.to_owned()
            } else {
                format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""))
            }
        })
        .collect::<Vec<_>>()
        .join(":");
    let temporary =
        std::env::temp_dir().join(format!("t3code-commit-index-{}", conn_support::uuid_v4()));
    let _cleanup = Scratch(temporary.clone());
    let original = std::path::PathBuf::from(index.trim());
    let scratch = temporary.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir(&scratch)?;
        std::fs::create_dir(scratch.join("objects"))?;
        match std::fs::copy(original, scratch.join("index")) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|result| result.map_err(|e| e.to_string()))
    .map_err(|detail| VcsError::invalid("prepareCommitContext", &cwd.to_string_lossy(), detail))?;
    let index = temporary.join("index");
    async {
        indexed(
            command(
                cwd,
                [
                    "-c",
                    "core.splitIndex=false",
                    "update-index",
                    "--no-split-index",
                ],
            ),
            &index,
            &alternates,
        )
        .run()
        .await?;
        stage(cwd, selected, Some((&index, &alternates))).await?;
        let summary = indexed(
            command(
                cwd,
                [
                    "-c",
                    "diff.relative=false",
                    "diff",
                    "--cached",
                    "--name-status",
                ],
            ),
            &index,
            &alternates,
        )
        .text()
        .await?;
        if summary.trim().is_empty() && operation_in_progress(cwd).await? != Some("merge") {
            return Ok(None);
        }
        let patch = if include_patch {
            let output = indexed(
                command(
                    cwd,
                    [
                        "-c",
                        "diff.relative=false",
                        "diff",
                        "--cached",
                        "--no-ext-diff",
                        "--no-color",
                        "--no-textconv",
                        "--patch",
                        "--minimal",
                    ],
                ),
                &index,
                &alternates,
            )
            .max_stdout(
                crate::generated::PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
                OnLimit::Truncate,
            )
            .run()
            .await?;
            let mut patch = output.stdout_text();
            if output.stdout_truncated {
                patch.push_str("\n\n[truncated]");
            }
            patch
        } else {
            String::new()
        };
        Ok(Some(Context {
            summary: summary.trim().into(),
            patch,
        }))
    }
    .await
}

pub async fn create(
    cwd: &Path,
    subject: &str,
    body: &str,
    selected: Option<&[String]>,
) -> VcsResult<String> {
    stage(cwd, selected, None).await?;
    let mut args = vec!["commit".into(), "-m".into(), subject.into()];
    if !body.trim().is_empty() {
        args.extend(["-m".into(), body.trim().into()]);
    }
    // T3 uses --only only when unselected conflict stages have to survive.
    let unmerged = command(
        cwd,
        diff(["--cached", "--name-only", "--diff-filter=U", "-z"]),
    )
    .text()
    .await?;
    let only = selected.filter(|_| !unmerged.is_empty());
    if let Some(selected) = only {
        args.extend(["--only".into(), "--".into()]);
        args.extend(paths(selected));
    }
    command(cwd, args).run().await?;
    if let Some(selected) = only {
        let mut args = vec!["reset".into(), "--quiet".into(), "HEAD".into(), "--".into()];
        args.extend(paths(selected));
        command(cwd, args).run().await?;
    }
    Ok(command(cwd, ["rev-parse", "HEAD"])
        .text()
        .await?
        .trim()
        .into())
}

#[cfg(test)]
mod tests {
    use super::{marker_report, path_batches, split_records};
    use std::ffi::OsString;

    #[test]
    fn records_survive_every_chunk_boundary() {
        let output = b"a.txt:1: leftover conflict marker\n\nb.txt:3: trailing whitespace.\n+x \nc";
        let want: Vec<&[u8]> = vec![
            b"a.txt:1: leftover conflict marker",
            b"b.txt:3: trailing whitespace.",
            b"+x ",
        ];
        for split in 0..=output.len() {
            let (head, tail) = output.split_at(split);
            let mut records = Vec::new();
            let mut partial = Vec::new();
            for chunk in [head, tail] {
                split_records(&mut partial, chunk, b'\n', &mut |record: &[u8]| {
                    records.push(record.to_vec());
                });
            }
            assert_eq!(records, want, "split at {split}");
            assert_eq!(partial, b"c", "split at {split}");
        }
    }

    #[test]
    fn splits_paths_into_batches_under_the_argument_limit() {
        let paths: Vec<OsString> = (0..20_000)
            .map(|n| format!("dir/{n:0>40}.txt").into())
            .collect();
        let batches = path_batches(&paths);
        assert!(batches.len() > 1);
        assert_eq!(batches.concat(), paths);
        for batch in batches {
            assert!(batch.iter().map(|p| p.len() + 24).sum::<usize>() <= 128 * 1024);
        }
        assert!(path_batches(&[]).is_empty());
    }

    #[test]
    fn reads_only_leftover_marker_reports() {
        for (line, want) in [
            (
                &b"notes.txt:12: leftover conflict marker"[..],
                Some((&b"notes.txt"[..], 12)),
            ),
            (
                b"a:b.txt:3: leftover conflict marker",
                Some((b"a:b.txt", 3)),
            ),
            (
                b"odd\xffname.txt:1: leftover conflict marker",
                Some((b"odd\xffname.txt", 1)),
            ),
            (b"notes.txt:3: trailing whitespace.", None),
            (b"+<<<<<<< HEAD", None),
            (b"notes.txt:+3: leftover conflict marker", None),
            (b"notes.txt:: leftover conflict marker", None),
            (b"3: leftover conflict marker", None),
        ] {
            assert_eq!(marker_report(line), want, "{}", line.escape_ascii());
        }
    }
}
