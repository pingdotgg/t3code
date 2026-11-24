//! Workspace-local PHP and Laravel definitions over persistent language-server sessions.
use crate::{paths::InternalPaths, workspace};
use conn_contract::{
    ProjectReadFileInput,
    source::{DefinitionQuery, DefinitionTarget, SourceLines, workspace_relative},
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    hash::{DefaultHasher, Hash, Hasher},
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot},
    time::timeout,
};
use url::Url;

type Answer = Result<Vec<DefinitionTarget>, String>;
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionMode {
    #[default]
    All,
    First,
    Hover,
}

enum Work {
    Lookup(Box<Lookup>),
    Warm(oneshot::Sender<Result<(), String>>),
}
struct Lookup {
    offset: usize,
    mode: DefinitionMode,
    uri: Url,
    workspace: PathBuf,
    laravel: bool,
    contents: String,
    query: DefinitionQuery,
    internal: InternalPaths,
    answer: oneshot::Sender<Answer>,
}

#[derive(Default, Debug)]
pub struct LaravelNavigation {
    sessions: Mutex<HashMap<PathBuf, mpsc::Sender<Work>>>,
}

impl LaravelNavigation {
    pub async fn definition(
        &self,
        root: &str,
        query: DefinitionQuery,
        internal: &InternalPaths,
    ) -> Answer {
        self.lookup(root, query, internal, DefinitionMode::All)
            .await
    }

    pub async fn lookup(
        &self,
        root: &str,
        query: DefinitionQuery,
        internal: &InternalPaths,
        mode: DefinitionMode,
    ) -> Answer {
        if !workspace_relative(&query.path)
            || !query.path.ends_with(".php")
            || query.line == 0
            || query.column == 0
        {
            return Err("Use a relative PHP path and positive line and column.".into());
        }
        let (answer, rx) = oneshot::channel();
        let root = root.to_owned();
        let internal = internal.clone();
        let (artisan, lookup) =
            tokio::task::spawn_blocking(move || prepare(&root, query, internal, answer, mode))
                .await
                .map_err(|_| "Cannot prepare source lookup.")??;
        self.enqueue(artisan, Work::Lookup(Box::new(lookup)))?;
        timeout(Duration::from_secs(45), rx)
            .await
            .map_err(|_| "Language server lookup timed out.")?
            .map_err(|_| "Language server stopped.")?
    }

    pub async fn warm_php(
        &self,
        root: &str,
        path: String,
        internal: &InternalPaths,
    ) -> Result<(), String> {
        let root = root.to_owned();
        let internal = internal.clone();
        let project =
            tokio::task::spawn_blocking(move || navigation_paths(&root, &path, &internal))
                .await
                .map_err(|_| "Cannot prepare PHP navigation.")??
                .project;
        let (answer, rx) = oneshot::channel();
        self.enqueue(project, Work::Warm(answer))?;
        timeout(Duration::from_secs(45), rx)
            .await
            .map_err(|_| "PHP navigation warm-up timed out.")?
            .map_err(|_| "PHP navigation stopped.")?
    }

    fn enqueue(&self, artisan: PathBuf, work: Work) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Navigation service unavailable.")?;
        sessions.retain(|_, tx| !tx.is_closed());
        if sessions.len() >= 8 && !sessions.contains_key(&artisan) {
            return Err("All language server slots are busy.".into());
        }
        let tx = sessions.entry(artisan.clone()).or_insert_with(|| {
            let (tx, rx) = mpsc::channel(8);
            tokio::spawn(serve(artisan, rx));
            tx
        });
        tx.try_send(work)
            .map_err(|_| "The language server is busy. Try the lookup again.".to_owned())
    }
}

struct NavigationPaths {
    workspace: PathBuf,
    source: PathBuf,
    project: PathBuf,
    laravel: bool,
}

fn navigation_paths(
    root: &str,
    relative: &str,
    internal: &InternalPaths,
) -> Result<NavigationPaths, String> {
    if !workspace_relative(relative) || !relative.ends_with(".php") {
        return Err("Expected a workspace-relative PHP file.".into());
    }
    let workspace = Path::new(root)
        .canonicalize()
        .map_err(|_| "Workspace is unavailable.")?;
    if workspace.parent().is_none() {
        return Err("Expected a project workspace.".into());
    }
    let path = workspace
        .join(relative)
        .canonicalize()
        .map_err(|_| "Source file is unavailable.")?;
    if !path.is_file() || !path.starts_with(&workspace) || internal.contains(&path) {
        return Err("Source file is outside the workspace.".into());
    }
    let artisan = path
        .ancestors()
        .skip(1)
        .take_while(|p| p.starts_with(&workspace))
        .find(|p| p.join("artisan").is_file());
    let project = artisan
        .or_else(|| {
            path.ancestors()
                .skip(1)
                .take_while(|p| p.starts_with(&workspace))
                .find(|p| p.join("composer.json").is_file())
        })
        .unwrap_or(&workspace)
        .to_owned();
    let laravel = artisan.is_some();
    Ok(NavigationPaths {
        workspace,
        source: path,
        project,
        laravel,
    })
}

fn prepare(
    root: &str,
    query: DefinitionQuery,
    internal: InternalPaths,
    answer: oneshot::Sender<Answer>,
    mode: DefinitionMode,
) -> Result<(PathBuf, Lookup), String> {
    let paths = navigation_paths(root, &query.path, &internal)?;
    let file = workspace::read_file(
        &ProjectReadFileInput {
            cwd: root.into(),
            relative_path: query.path.clone(),
            allow_missing: None,
        },
        None,
        &internal,
    )
    .map_err(|_| "Cannot read this source file.")?;
    if file.truncated {
        return Err("File exceeds the source navigation limit.".into());
    }
    let offset = source_offset(&file.contents, &query).ok_or("The source line changed or the position is outside the file. Reopen the file and try again.")?;
    let lookup = Lookup {
        mode,
        offset,
        uri: Url::from_file_path(paths.source).map_err(|_| "Invalid file URI.")?,
        workspace: paths.workspace,
        laravel: paths.laravel,
        contents: file.contents,
        query,
        internal,
        answer,
    };
    Ok((paths.project, lookup))
}

#[derive(PartialEq, Eq)]
struct CallSite {
    path: String,
    offset: usize,
    source_hash: u64,
}

impl CallSite {
    fn new(request: &Lookup) -> Self {
        let mut hash = DefaultHasher::new();
        request.contents.hash(&mut hash);
        Self {
            path: request.query.path.clone(),
            offset: request.offset,
            source_hash: hash.finish(),
        }
    }
}

struct ResolvedSite {
    target: DefinitionTarget,
    modified: Option<SystemTime>,
}

impl ResolvedSite {
    async fn current(&self, request: &Lookup) -> bool {
        let path = request.workspace.join(&self.target.path);
        let internal = request.internal.clone();
        let modified = self.modified;
        tokio::task::spawn_blocking(move || {
            modified.is_some()
                && path
                    .canonicalize()
                    .is_ok_and(|actual| actual == path && !internal.contains(&actual))
                && path
                    .metadata()
                    .is_ok_and(|m| m.is_file() && m.modified().ok() == modified)
        })
        .await
        .unwrap_or(false)
    }
}

async fn serve(artisan: PathBuf, mut requests: mpsc::Receiver<Work>) {
    let dirty = Arc::new(AtomicBool::new(false));
    let flag = dirty.clone();
    let base = artisan.clone();
    let watch = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.map_or(true, |e| {
            !e.kind.is_access()
                && (e.need_rescan()
                    || e.paths.is_empty()
                    || e.paths.iter().any(|p| {
                        p.strip_prefix(&base).is_ok_and(|relative| {
                            ![".git", "storage", "node_modules", "bootstrap/cache"]
                                .iter()
                                .any(|ignore| relative.starts_with(ignore))
                        })
                    }))
        }) {
            flag.store(true, Ordering::Release);
        }
    })
    .and_then(|mut w: RecommendedWatcher| {
        w.watch(&artisan, RecursiveMode::Recursive)?;
        Ok(w)
    });
    let mut php = None;
    let mut laravel = None;
    let mut reflection_ready = false;
    let mut resolved: VecDeque<(CallSite, ResolvedSite)> = VecDeque::new();
    while let Ok(Some(work)) = timeout(Duration::from_secs(90), requests.recv()).await {
        let request = match work {
            Work::Lookup(request) => request,
            Work::Warm(answer) => {
                if !answer.is_closed() {
                    let result = if reflection_ready {
                        Ok(())
                    } else {
                        warm_reflection(&artisan).await
                    };
                    reflection_ready = result.is_ok();
                    let _ = answer.send(result);
                }
                continue;
            }
        };
        if request.answer.is_closed() {
            continue;
        }
        if dirty.swap(false, Ordering::AcqRel) || watch.is_err() {
            php = None;
            laravel = None;
            resolved.clear();
        }
        // A nested project can depend on files outside the watched directory.
        let site =
            (watch.is_ok() && request.workspace == artisan && request.mode != DefinitionMode::All)
                .then(|| CallSite::new(&request));
        if let Some(key) = &site
            && let Some((_, hit)) = resolved.iter().find(|(stored, _)| stored == key)
            && hit.current(&request).await
        {
            let _ = request.answer.send(Ok(vec![hit.target.clone()]));
            continue;
        }
        if request.mode != DefinitionMode::All
            && (php.is_none() || request.mode == DefinitionMode::Hover)
            && !request.query.path.ends_with(".blade.php")
            && let Ok(Some(target)) = timeout(
                Duration::from_secs(8),
                direct_definition(&artisan, &request),
            )
            .await
        {
            reflection_ready = true;
            let _ = request.answer.send(Ok(vec![target.target.clone()]));
            if let Some(key) = site {
                resolved.retain(|(stored, _)| stored != &key);
                if resolved.len() >= 128 {
                    resolved.pop_front();
                }
                resolved.push_back((key, target));
            }
            continue;
        }
        if request.mode == DefinitionMode::Hover {
            // A speculative miss must not queue an index build ahead of the next click.
            let _ = request.answer.send(Ok(Vec::new()));
            continue;
        }
        let result = if request.query.path.ends_with(".blade.php") && request.laravel {
            lookup_with(&mut laravel, "laravel-lsp", &artisan, &request).await
        } else {
            let first = lookup_with(&mut php, "phpactor", &artisan, &request).await;
            if !request.laravel || first.as_ref().is_ok_and(|targets| !targets.is_empty()) {
                first
            } else {
                match lookup_with(&mut laravel, "laravel-lsp", &artisan, &request).await {
                    Ok(targets) if !targets.is_empty() => Ok(targets),
                    Ok(_) => first,
                    Err(second) => first.map_err(|first| format!("{first} {second}")),
                }
            }
        };
        let _ = request.answer.send(result);
    }
}

// The reflection map is persisted by Phpactor and shared by its CLI and language server.
async fn warm_reflection(root: &Path) -> Result<(), String> {
    let status = timeout(
        Duration::from_secs(10),
        Command::new("phpactor")
            .args(["class:reflect", "stdClass"])
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status(),
    )
    .await
    .map_err(|_| "Phpactor preparation timed out.")?
    .map_err(|e| format!("Cannot prepare Phpactor: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "Phpactor could not prepare reflection.".into())
}

fn source_offset(contents: &str, query: &DefinitionQuery) -> Option<usize> {
    let mut start = 0;
    for (index, line) in contents.split('\n').enumerate() {
        if index + 1 == query.line as usize {
            let line = line.trim_end_matches('\r');
            if query
                .expected_line
                .as_deref()
                .is_some_and(|expected| expected != line)
            {
                return None;
            }
            let mut units = 1;
            for (byte, ch) in line.char_indices() {
                if units == query.column {
                    return Some(start + byte);
                }
                units += ch.len_utf16() as u32;
            }
            return (units == query.column).then_some(start + line.len());
        }
        start += line.len() + 1;
    }
    None
}

// Phpactor's single-target RPC uses the same definition locator without starting a workspace index job.
async fn direct_definition(root: &Path, lookup: &Lookup) -> Option<ResolvedSite> {
    let offset = lookup.offset;
    let path = lookup.uri.to_file_path().ok()?;
    let input = serde_json::to_vec(&json!({"action":"goto_definition","parameters":{
        "source":lookup.contents,"path":path,"offset":offset
    }}))
    .ok()?;
    let mut child = Command::new("phpactor")
        .args([
            "rpc",
            "--no-interaction",
            "--config-extra={\"class_to_file.brute_force_conversion\":false}",
        ])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(&input).await.ok()?;
    let mut output = Vec::new();
    child
        .stdout
        .take()?
        .take(65537)
        .read_to_end(&mut output)
        .await
        .ok()?;
    if output.len() > 65536 || !child.wait().await.ok()?.success() {
        return None;
    }
    let reply: Value = serde_json::from_slice(&output).ok()?;
    if reply["action"] != "open_file" {
        return None;
    }
    let absolute = PathBuf::from(reply.pointer("/parameters/path")?.as_str()?);
    if !absolute.is_absolute() {
        return None;
    }
    let byte = usize::try_from(reply.pointer("/parameters/offset")?.as_u64()?).ok()?;
    let internal = lookup.internal.clone();
    let workspace = lookup.workspace.clone();
    tokio::task::spawn_blocking(move || {
        let absolute = absolute.canonicalize().ok()?;
        let modified = absolute.metadata().ok()?.modified().ok();
        let path = absolute.strip_prefix(&workspace).ok()?.to_str()?.to_owned();
        let file = workspace::read_file(
            &ProjectReadFileInput {
                cwd: workspace.to_str()?.into(),
                relative_path: path.clone(),
                allow_missing: None,
            },
            None,
            &internal,
        )
        .ok()?;
        if file.truncated {
            return None;
        }
        let start_line = file
            .contents
            .get(..byte)?
            .bytes()
            .filter(|b| *b == b'\n')
            .count()
            + 1;
        Some(ResolvedSite {
            modified,
            target: DefinitionTarget {
                path,
                lines: SourceLines {
                    start_line,
                    end_line: start_line,
                },
            },
        })
    })
    .await
    .ok()
    .flatten()
}

async fn lookup_with(
    slot: &mut Option<Session>,
    program: &str,
    root: &Path,
    request: &Lookup,
) -> Answer {
    let result = timeout(Duration::from_secs(20), async {
        let session = match slot {
            Some(session) => session,
            None => slot.insert(Session::start(root, program).await?),
        };
        session.lookup(request).await
    })
    .await
    .unwrap_or_else(|_| Err(format!("{program} lookup timed out.")));
    if result.is_err() {
        *slot = None;
    }
    result
}

struct Session {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    id: u64,
}

impl Session {
    async fn start(root: &Path, program: &str) -> Result<Self, String> {
        let mut command = Command::new(program);
        if program == "phpactor" {
            command.arg("language-server");
        }
        let mut child = command
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Cannot start {program} in this workspace: {e}"))?;
        let mut session = Self {
            input: child.stdin.take().ok_or("No language server stdin.")?,
            output: BufReader::new(child.stdout.take().ok_or("No language server stdout.")?),
            _child: child,
            id: 0,
        };
        let uri = Url::from_directory_path(root).map_err(|_| "Invalid artisan root.")?;
        let capabilities = session.call("initialize",json!({"processId":std::process::id(),"rootUri":uri.as_str(),"workspaceFolders":[{"uri":uri.as_str(),"name":"Laravel"}],"capabilities":{"general":{"positionEncodings":["utf-16"]}},"initializationOptions":{"phpEnvironment":"local","pestGenerateDocBlocks":false}})).await?;
        if !matches!(
            capabilities.pointer("/capabilities/definitionProvider"),
            Some(Value::Bool(true) | Value::Object(_))
        ) {
            return Err(format!("{program} does not support definitions."));
        }
        session.notify("initialized", json!({})).await?;
        Ok(session)
    }

    async fn lookup(&mut self, lookup: &Lookup) -> Answer {
        let uri = &lookup.uri;
        self.notify("textDocument/didOpen",json!({"textDocument":{"uri":uri.as_str(),"languageId":if lookup.query.path.ends_with(".blade.php") {"blade"}else{"php"},"version":1,"text":lookup.contents}})).await?;
        let reply=self.call("textDocument/definition",json!({"textDocument":{"uri":uri.as_str()},"position":{"line":lookup.query.line-1,"character":lookup.query.column-1}})).await?;
        self.notify(
            "textDocument/didClose",
            json!({"textDocument":{"uri":uri.as_str()}}),
        )
        .await?;
        Ok(match &reply {
            Value::Array(items) => items
                .iter()
                .filter_map(|item| target(item, lookup))
                .collect(),
            item => target(item, lookup).into_iter().collect(),
        })
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write(json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.id += 1;
        self.write(json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params}))
            .await?;
        loop {
            let frame = read_frame(&mut self.output)
                .await
                .map_err(|e| format!("Invalid language server response: {e}"))?;
            if let Some(method) = frame["method"].as_str() {
                if !frame["id"].is_null() {
                    let id = &frame["id"];
                    let reply = match method {
                        "client/registerCapability" | "window/workDoneProgress/create" => {
                            json!({"jsonrpc":"2.0","id":id,"result":null})
                        }
                        "workspace/configuration" => {
                            let items = frame
                                .pointer("/params/items")
                                .and_then(Value::as_array)
                                .map_or(0, Vec::len);
                            json!({"jsonrpc":"2.0","id":id,"result":vec![Value::Null;items]})
                        }
                        _ => {
                            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unsupported client method"}})
                        }
                    };
                    self.write(reply).await?;
                }
            } else if frame["id"] == self.id {
                if let Some(err) = frame.get("error") {
                    return Err(err["message"]
                        .as_str()
                        .unwrap_or("Laravel lookup failed.")
                        .into());
                }
                return frame
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "Missing language server result.".into());
            }
        }
    }

    async fn write(&mut self, frame: Value) -> Result<(), String> {
        let bytes = serde_json::to_vec(&frame).map_err(|e| e.to_string())?;
        self.input
            .write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        self.input
            .write_all(&bytes)
            .await
            .map_err(|e| e.to_string())?;
        self.input.flush().await.map_err(|e| e.to_string())
    }
}

async fn read_frame(output: &mut (impl tokio::io::AsyncBufRead + Unpin)) -> io::Result<Value> {
    let mut headers = Vec::new();
    let mut bounded = (&mut *output).take(8192);
    loop {
        let start = headers.len();
        if bounded.read_until(b'\n', &mut headers).await? == 0 {
            return Err(io::Error::other("incomplete frame headers"));
        }
        if headers[start..] == *b"\r\n" {
            break;
        }
    }
    let size = std::str::from_utf8(&headers)
        .ok()
        .and_then(|h| {
            h.lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(k, _)| k.eq_ignore_ascii_case("Content-Length"))
                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        })
        .filter(|n| *n <= 4 * 1024 * 1024)
        .ok_or_else(|| io::Error::other("invalid content length"))?;
    let mut bytes = vec![0; size];
    output.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

fn target(location: &Value, lookup: &Lookup) -> Option<DefinitionTarget> {
    let uri = location
        .get("targetUri")
        .or_else(|| location.get("uri"))?
        .as_str()?;
    let absolute = Url::parse(uri)
        .ok()?
        .to_file_path()
        .ok()?
        .canonicalize()
        .ok()?;
    if lookup.internal.contains(&absolute) || !absolute.is_file() {
        return None;
    }
    let path = absolute
        .strip_prefix(&lookup.workspace)
        .ok()?
        .to_str()?
        .to_owned();
    let range = location
        .get("targetSelectionRange")
        .or_else(|| location.get("range"))?;
    let line = |key: &str| {
        usize::try_from(range[key]["line"].as_u64()?)
            .ok()?
            .checked_add(1)
    };
    let start_line = line("start")?;
    let end = line("end")?;
    let end_line = if end > start_line && range["end"]["character"] == 0 {
        end - 1
    } else {
        end
    };
    (end_line >= start_line).then_some(DefinitionTarget {
        path,
        lines: SourceLines {
            start_line,
            end_line,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn framed_definition_leaves_the_next_message_in_the_stream() {
        let message = br#"{"result":"source"}"#;
        let mut wire = format!(
            "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
            message.len()
        )
        .into_bytes();
        wire.extend(message);
        wire.extend(b"Content-Length: 4\r\n\r\nnull");
        let mut stream = BufReader::new(&wire[..]);
        assert_eq!(read_frame(&mut stream).await.unwrap()["result"], "source");
        assert_eq!(read_frame(&mut stream).await.unwrap(), Value::Null);
        assert!(
            read_frame(&mut &b"Content-Length: 999999999\r\n\r\n"[..])
                .await
                .is_err()
        );
    }

    #[test]
    fn php_columns_use_utf16_and_end_on_scalar_boundaries() {
        let mut query = DefinitionQuery {
            path: "routes/web.php".into(),
            line: 2,
            column: 3,
            expected_line: None,
        };
        assert_eq!(source_offset("<?php\n🦀x", &query), Some(10));
        assert_eq!(source_offset("<?php\r\n🦀x", &query), Some(11));
        query.column = 2;
        assert_eq!(source_offset("<?php\n🦀x", &query), None);
        query.column = 5;
        assert_eq!(source_offset("<?php\n🦀x", &query), None);
    }

    #[tokio::test]
    async fn cached_method_requires_the_same_source_and_current_target() {
        let root = std::env::temp_dir().join(conn_support::uuid_v4());
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let source = root.join("Calls.php");
        let target = root.join("Table.php");
        std::fs::write(&source, "<?php $x->run();").unwrap();
        std::fs::write(&target, "<?php class Table {}").unwrap();
        let (reply, _) = oneshot::channel();
        let (_, mut request) = prepare(
            root.to_str().unwrap(),
            DefinitionQuery {
                path: "Calls.php".into(),
                line: 1,
                column: 11,
                expected_line: None,
            },
            InternalPaths::new(&root.join(".state")),
            reply,
            DefinitionMode::First,
        )
        .unwrap();
        let key = CallSite::new(&request);
        let cached = ResolvedSite {
            target: DefinitionTarget {
                path: "Table.php".into(),
                lines: SourceLines {
                    start_line: 1,
                    end_line: 1,
                },
            },
            modified: target.metadata().unwrap().modified().ok(),
        };
        assert!(cached.current(&request).await);
        request.contents = "<?php $y->run();".into();
        assert!(key != CallSite::new(&request));
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1))
            .unwrap();
        assert!(!cached.current(&request).await);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    #[ignore = "requires phpactor on PATH and a Laravel skeleton in CONN_LARAVEL_FIXTURE"]
    async fn real_php_class_definition() {
        let root = std::env::var("CONN_LARAVEL_FIXTURE").expect("Laravel skeleton");
        let path = "app/Models/User.php";
        let source = std::fs::read_to_string(Path::new(&root).join(path)).unwrap();
        let (line, reference) = source
            .lines()
            .enumerate()
            .find(|(_, line)| line.contains("extends Authenticatable"))
            .unwrap();
        let query = DefinitionQuery {
            path: path.into(),
            line: line as u32 + 1,
            column: reference[..reference.find("Authenticatable").unwrap()]
                .encode_utf16()
                .count() as u32
                + 1,
            expected_line: Some(reference.into()),
        };
        let state = InternalPaths::new(&Path::new(&root).join(".conn-test-state"));
        let service = LaravelNavigation::default();
        service.warm_php(&root, path.into(), &state).await.unwrap();
        for mode in [
            DefinitionMode::Hover,
            DefinitionMode::First,
            DefinitionMode::All,
        ] {
            let targets = service
                .lookup(&root, query.clone(), &state, mode)
                .await
                .unwrap();
            let target = targets.first().expect("PHP class declaration");
            assert_eq!(
                target.path,
                "vendor/laravel/framework/src/Illuminate/Foundation/Auth/User.php"
            );
            let definition = std::fs::read_to_string(Path::new(&root).join(&target.path)).unwrap();
            assert!(
                definition
                    .lines()
                    .nth(target.lines.start_line - 1)
                    .unwrap()
                    .contains("class User")
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires laravel-lsp on PATH and a Laravel skeleton in CONN_LARAVEL_FIXTURE"]
    async fn real_laravel_welcome_definition() {
        let root = std::env::var("CONN_LARAVEL_FIXTURE").expect("Laravel skeleton");
        let state = InternalPaths::new(Path::new(&root).join(".conn-test-state").as_path());
        let app = LaravelNavigation::default();
        let routes = std::fs::read_to_string(Path::new(&root).join("routes/web.php")).unwrap();
        let (line, source) = routes
            .lines()
            .enumerate()
            .find(|(_, line)| line.contains("'welcome'"))
            .unwrap();
        let column = source[..source.find("welcome").unwrap()]
            .encode_utf16()
            .count()
            + 2;
        let query = DefinitionQuery {
            path: "routes/web.php".into(),
            line: line as u32 + 1,
            column: column as u32,
            expected_line: None,
        };
        for mode in [DefinitionMode::First, DefinitionMode::All] {
            let targets = app
                .lookup(&root, query.clone(), &state, mode)
                .await
                .unwrap();
            assert_eq!(
                targets.first().map(|t| t.path.as_str()),
                Some("resources/views/welcome.blade.php")
            );
        }
    }
}
