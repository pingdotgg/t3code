//! Commit preparation uses a scratch index; only the final commit changes the real index.
use crate::{
    VcsError, VcsResult,
    process::{GitCommand, OnLimit},
    repo,
};
use std::{path::Path, time::Duration};

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

fn paths(paths: &[String]) -> Vec<String> {
    paths.iter().map(|p| format!(":(top,literal){p}")).collect()
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

async fn stage(
    cwd: &Path,
    selected: Option<&[String]>,
    index: Option<(&Path, &str)>,
) -> VcsResult<()> {
    let run = |args: Vec<String>| {
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
        }
        let unmerged = run(vec![
            "diff".into(),
            "--cached".into(),
            "--name-only".into(),
            "--diff-filter=U".into(),
            "-z".into(),
        ])
        .text()
        .await?;
        if index.is_none()
            && !unmerged
                .split('\0')
                .any(|p| !p.is_empty() && !selected.iter().any(|s| s == p))
        {
            run(vec!["reset".into(), "--quiet".into()]).run().await?;
        }
    } else {
        let unmerged = run(vec![
            "diff".into(),
            "--name-only".into(),
            "--diff-filter=U".into(),
            "-z".into(),
        ])
        .text()
        .await?;
        if !unmerged.is_empty() {
            let checked = run(vec!["diff".into(), "--check".into()])
                .allow_exit(&[2])
                .text()
                .await?;
            let empty = run(vec![
                "hash-object".into(),
                "-t".into(),
                "tree".into(),
                "--stdin".into(),
            ])
            .stdin(Vec::new())
            .text()
            .await?;
            let mut conflicted = Vec::new();
            for file in unmerged.split('\0').filter(|file| !file.is_empty()) {
                let prefix = format!("{file}:");
                let lines = checked
                    .lines()
                    .filter_map(|line| {
                        line.strip_prefix(&prefix)
                            .and_then(|line| line.strip_suffix(": leftover conflict marker"))
                            .and_then(|number| number.parse::<usize>().ok())
                    })
                    .collect::<Vec<_>>();
                if lines.is_empty() {
                    continue;
                }
                let patch = run(vec![
                    "diff".into(),
                    "--no-color".into(),
                    "--no-ext-diff".into(),
                    "--no-textconv".into(),
                    "--text".into(),
                    empty.trim().into(),
                    "--".into(),
                    format!(":(top,literal){file}"),
                ])
                .text()
                .await?;
                let added = patch
                    .lines()
                    .skip_while(|line| !line.starts_with("@@"))
                    .filter_map(|line| line.strip_prefix('+'))
                    .collect::<Vec<_>>();
                let reported = |marker| {
                    added.iter().enumerate().any(|(index, line)| {
                        lines.contains(&(index + 1)) && line.starts_with(marker)
                    })
                };
                if reported('<') && reported('>') {
                    conflicted.push(file);
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
        ["diff", "--cached", "--name-only", "--diff-filter=U", "-z"],
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
