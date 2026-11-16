//! Bounded reads of Claude's workflow scripts (`workflowScriptQuery.ts`).

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub(crate) async fn get(script: String) -> Result<Value, Value> {
    tokio::task::spawn_blocking(move || {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        read(&script, &home)
    })
    .await
    .map_err(|_| error("read-failed", ""))?
}

fn error(reason: &str, script: &str) -> Value {
    json!({"_tag":"OrchestrationGetWorkflowScriptError", "reason":reason, "scriptPath":script})
}

fn read(script: &str, home: &Path) -> Result<Value, Value> {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    let path = Path::new(script);
    let fail = |reason| error(reason, script);
    if !path.is_absolute() || path.extension().is_none_or(|ext| ext != "js") {
        return Err(fail("invalid-path"));
    }
    if !home.is_absolute() {
        return Err(fail("root-unavailable"));
    }
    let root = std::fs::canonicalize(home.join(".claude/projects"))
        .map_err(|_| fail("root-unavailable"))?;
    let resolved = std::fs::canonicalize(path).map_err(|_| fail("not-found"))?;
    let resolved_text = resolved.to_string_lossy();
    let fail = |reason| error(reason, &resolved_text);
    if !resolved.starts_with(&root) {
        return Err(fail("outside-root"));
    }
    if resolved.extension().is_none_or(|ext| ext != "js") {
        return Err(fail("not-js"));
    }
    let fd = rustix::fs::open(
        &resolved,
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::NONBLOCK | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )
    .map_err(|_| fail("read-failed"))?;
    let file = std::fs::File::from(fd);
    let stat = file.metadata().map_err(|_| fail("read-failed"))?;
    if !stat.is_file() {
        return Err(fail("not-regular-file"));
    }
    let path_stat = std::fs::symlink_metadata(&resolved).map_err(|_| fail("read-failed"))?;
    if stat.ino() != path_stat.ino() || stat.dev() != path_stat.dev() {
        return Err(fail("changed-during-read"));
    }
    const BYTE_CAP: u64 = 256 * 1024;
    let mut bytes = Vec::new();
    file.take(stat.len().min(BYTE_CAP))
        .read_to_end(&mut bytes)
        .map_err(|_| fail("read-failed"))?;
    Ok(
        json!({"scriptPath":resolved_text, "contents":String::from_utf8_lossy(&bytes), "truncated":stat.len() > BYTE_CAP}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contained_scripts_resolve_symlinks_and_cap_bytes() {
        let home =
            std::env::temp_dir().join(format!("conn-workflow-script-{}", conn_support::uuid_v4()));
        let root = home.join(".claude/projects");
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("run.js");
        std::fs::write(&script, "a".repeat(256 * 1024 + 1)).unwrap();
        let got = read(script.to_str().unwrap(), &home).unwrap();
        assert_eq!(got["contents"].as_str().unwrap().len(), 256 * 1024);
        assert_eq!(got["truncated"], true);
        assert_eq!(
            got["scriptPath"],
            std::fs::canonicalize(&script).unwrap().to_str().unwrap()
        );
        std::fs::write(&script, "// hello").unwrap();
        assert_eq!(
            read(script.to_str().unwrap(), &home).unwrap()["contents"],
            "// hello"
        );
        let cwd = std::env::current_dir().unwrap();
        let mut relative_home: PathBuf = cwd.ancestors().skip(1).map(|_| "..").collect();
        relative_home.push(home.strip_prefix("/").unwrap());
        for invalid_home in [Path::new(""), relative_home.as_path()] {
            assert_eq!(
                read(script.to_str().unwrap(), invalid_home).unwrap_err(),
                error("root-unavailable", script.to_str().unwrap()),
                "HOME {}",
                invalid_home.display()
            );
        }
        let outside = home.join("outside.js");
        std::fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape.js")).unwrap();
        std::os::unix::fs::symlink(&script, root.join("alias.js")).unwrap();
        std::fs::write(root.join("wrong.txt"), "text").unwrap();
        std::os::unix::fs::symlink(root.join("wrong.txt"), root.join("wrong.js")).unwrap();
        std::fs::create_dir(root.join("dir.js")).unwrap();
        for (path, reason) in [
            (PathBuf::from("relative.js"), "invalid-path"),
            (root.join("run.txt"), "invalid-path"),
            (root.join("missing.js"), "not-found"),
            (root.join("escape.js"), "outside-root"),
            (root.join("wrong.js"), "not-js"),
            (root.join("dir.js"), "not-regular-file"),
        ] {
            assert_eq!(
                read(path.to_str().unwrap(), &home).unwrap_err()["reason"],
                reason,
                "{}",
                path.display()
            );
        }
        assert_eq!(
            read(root.join("alias.js").to_str().unwrap(), &home).unwrap()["contents"],
            "// hello"
        );
        std::fs::remove_dir_all(&home).unwrap();
        assert_eq!(
            read(script.to_str().unwrap(), &home).unwrap_err()["reason"],
            "root-unavailable"
        );
    }
}
