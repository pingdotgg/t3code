use super::{
    Client, Error, Lookup,
    normalize::{array, text},
};
use crate::http::Method;
pub(super) use conn_support::ids::encode_component as encode;
use serde_json::{Value, json};
fn is_sha(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}
pub(super) fn contains_file(files: &[Value], old: &str, new: &str) -> bool {
    files.iter().any(|f| {
        let path = text(f, "filename");
        let previous = text(f, "previous_filename");
        let old_path = if previous.is_empty() { path } else { previous };
        old_path == old && path == new
    })
}
impl Client {
    pub async fn diff_file_contents(&self, lookup: &Lookup, input: &Value) -> Result<Value, Error> {
        let commit = input.get("commit").and_then(Value::as_str);
        if commit.is_some_and(|c| !is_sha(c)) {
            return Err(Error::Failed(
                "The named commit was not a commit sha.".into(),
            ));
        }
        let old = text(input, "oldPath");
        let new = text(input, "newPath");
        let kind = text(input, "changeType");
        let mut found = false;
        for page in 1..=100 {
            let endpoint = commit.map_or_else(
                || format!("{}/files?per_page=100&page={page}", lookup.path()),
                |c| {
                    format!(
                        "repos/{}/{}/commits/{c}?per_page=100&page={page}",
                        lookup.owner, lookup.name
                    )
                },
            );
            let result = self.rest(&endpoint).await?;
            let files = if commit.is_some() {
                array(result.get("files"))
            } else {
                result.as_array().map_or(&[] as &[Value], Vec::as_slice)
            };
            if contains_file(files, old, new) {
                found = true;
                break;
            }
            if files.len() < 100 {
                break;
            }
        }
        if !found {
            return Err(Error::NotFound(
                "This file is not part of the change request.".into(),
            ));
        }
        let endpoint = commit.map_or_else(
            || lookup.path(),
            |c| format!("repos/{}/{}/commits/{c}", lookup.owner, lookup.name),
        );
        let refs = self.rest(&endpoint).await?;
        let base = if commit.is_some() {
            array(refs.get("parents"))
                .first()
                .map(|p| text(p, "sha"))
                .unwrap_or("")
        } else {
            refs.pointer("/base/sha")
                .and_then(Value::as_str)
                .unwrap_or("")
        };
        let head = if commit.is_some() {
            text(&refs, "sha")
        } else {
            refs.pointer("/head/sha")
                .and_then(Value::as_str)
                .unwrap_or("")
        };
        if !is_sha(head)
            || (!(commit.is_some() && kind == "new" && base.is_empty()) && !is_sha(base))
        {
            return Err(Error::Failed(commit.map_or_else(
                || {
                    format!(
                        "Pull request #{} reported no usable base and head revisions.",
                        lookup.number
                    )
                },
                |c| format!("Commit {c} reported no usable revisions for this file."),
            )));
        }
        let mut old_ref = base.to_owned();
        if commit.is_none()
            && kind != "new"
            && let Ok(compare) = self
                .rest(&format!(
                    "repos/{}/{}/compare/{base}...{head}?per_page=1&page=2",
                    lookup.owner, lookup.name
                ))
                .await
            && let Some(sha) = compare
                .pointer("/merge_base_commit/sha")
                .and_then(Value::as_str)
                .filter(|s| is_sha(s))
        {
            old_ref = sha.into();
        }
        let old_contents = if kind == "new" {
            String::new()
        } else {
            self.file(lookup, &old_ref, old).await?
        };
        let new_contents = if kind == "deleted" {
            String::new()
        } else {
            self.file(lookup, head, new).await?
        };
        Ok(json!({"oldContents":old_contents,"newContents":new_contents}))
    }
    async fn file(&self, lookup: &Lookup, revision: &str, path: &str) -> Result<String, Error> {
        let encoded = path.split('/').map(encode).collect::<Vec<_>>().join("/");
        let response = self
            .request(
                Method::Get,
                &format!(
                    "repos/{}/{}/contents/{encoded}?ref={}",
                    lookup.owner,
                    lookup.name,
                    encode(revision)
                ),
                None,
                "application/vnd.github.raw+json",
                1024 * 1024,
            )
            .await?;
        if response.truncated {
            return Err(Error::Failed(format!(
                "The diff file '{path}' exceeds the 1 MB expansion limit."
            )));
        }
        let contents = String::from_utf8(response.body)
            .map_err(|_| Error::Failed(format!("The diff file '{path}' is binary.")))?;
        if contents.contains('\0') {
            return Err(Error::Failed(format!("The diff file '{path}' is binary.")));
        }
        Ok(contents)
    }
}

pub fn files_patch(files: &[Value]) -> Value {
    let mut patch = String::new();
    let mut omitted = Vec::new();
    for file in files {
        let Some(filename) = file.get("filename").and_then(Value::as_str) else {
            continue;
        };
        let status = text(file, "status").trim().to_lowercase();
        let hunks = text(file, "patch");
        let added = file.get("additions").and_then(Value::as_i64).unwrap_or(0);
        let deleted = file.get("deletions").and_then(Value::as_i64).unwrap_or(0);
        if hunks.is_empty() && added + deleted > 0 {
            omitted.push(json!({"path":filename,"additions":added,"deletions":deleted}));
        }
        let previous = text(file, "previous_filename");
        let old = if status == "renamed" && !previous.is_empty() {
            previous
        } else {
            filename
        };
        patch.push_str(&format!(
            "diff --git {} {}\n",
            quote_path(&format!("a/{old}")),
            quote_path(&format!("b/{filename}"))
        ));
        match status.as_str() {
            "added" => patch.push_str("new file mode 100644\n"),
            "removed" => patch.push_str("deleted file mode 100644\n"),
            "renamed" => patch.push_str(&format!(
                "similarity index {}%\nrename from {}\nrename to {}\n",
                if !hunks.is_empty() || added + deleted > 0 {
                    0
                } else {
                    100
                },
                quote_path(old),
                quote_path(filename)
            )),
            _ => {}
        }
        patch.push_str(&format!(
            "--- {}\n+++ {}\n",
            if status == "added" {
                "/dev/null".into()
            } else {
                quote_path(&format!("a/{old}"))
            },
            if status == "removed" {
                "/dev/null".into()
            } else {
                quote_path(&format!("b/{filename}"))
            }
        ));
        if !hunks.is_empty() {
            patch.push_str(hunks);
            if !hunks.ends_with('\n') {
                patch.push('\n');
            }
        }
    }
    let mut result = json!({"patch":patch,"truncated":!omitted.is_empty(),"nextCursor":null});
    if !omitted.is_empty() {
        result["omittedFileStats"] = json!(omitted);
    }
    result
}
fn quote_path(path: &str) -> String {
    let mut body = String::new();
    let mut quoted = false;
    for ch in path.chars() {
        let escape = match ch {
            '"' => Some("\\\""),
            '\\' => Some("\\\\"),
            '\u{7}' => Some("\\a"),
            '\u{8}' => Some("\\b"),
            '\t' => Some("\\t"),
            '\n' => Some("\\n"),
            '\u{b}' => Some("\\v"),
            '\u{c}' => Some("\\f"),
            '\r' => Some("\\r"),
            _ => None,
        };
        if let Some(escape) = escape {
            body.push_str(escape);
            quoted = true;
        } else if ch < ' ' || ch == '\u{7f}' {
            use std::fmt::Write;
            let _ = write!(body, "\\{:03o}", ch as u32);
            quoted = true;
        } else {
            body.push(ch);
        }
    }
    if quoted { format!("\"{body}\"") } else { body }
}
impl Client {
    pub async fn diff(&self, lookup: &Lookup, input: &Value) -> Result<Value, Error> {
        if input.get("path").is_some() {
            return Err(Error::Failed(
                "This host cannot read one file of a change request's diff.".into(),
            ));
        }
        let commit = input.get("commit").and_then(Value::as_str);
        if commit.is_some_and(|c| !is_sha(c)) {
            return Err(Error::Failed(
                "The named commit was not a commit sha.".into(),
            ));
        }
        let cursor = input.get("cursor").and_then(Value::as_str);
        let page = if let Some(cursor) = cursor {
            if cursor.is_empty()
                || cursor.len() > 7
                || cursor.starts_with('0')
                || !cursor.bytes().all(|b| b.is_ascii_digit())
            {
                return Err(Error::Failed(
                    "The diff cursor was not one this pull request handed out.".into(),
                ));
            }
            cursor.parse::<u32>().map_err(|_| {
                Error::Failed("The diff cursor was not one this pull request handed out.".into())
            })?
        } else {
            1
        };
        if commit.is_none() && cursor.is_none() {
            match self
                .request(
                    Method::Get,
                    &lookup.path(),
                    None,
                    "application/vnd.github.diff",
                    8 * 1024 * 1024,
                )
                .await
            {
                Ok(response) if !response.truncated => {
                    return Ok(
                        json!({"patch":response.text(),"truncated":false,"nextCursor":null}),
                    );
                }
                Err(error @ (Error::Unauthenticated | Error::Missing)) => return Err(error),
                Err(error) if matches!(error, Error::RateLimited) => {
                    return Err(error);
                }
                _ => {}
            }
        }
        let endpoint = commit.map_or_else(
            || format!("{}/files?per_page=100&page={page}", lookup.path()),
            |c| {
                format!(
                    "repos/{}/{}/commits/{c}?per_page=100&page={page}",
                    lookup.owner, lookup.name
                )
            },
        );
        let raw = self.rest(&endpoint).await?;
        let files = if commit.is_some() {
            array(raw.get("files"))
        } else {
            raw.as_array().map_or(&[] as &[Value], Vec::as_slice)
        };
        let mut result = files_patch(files);
        if files.len() >= 100 {
            result["nextCursor"] = json!((page + 1).to_string());
        }
        Ok(result)
    }
}
