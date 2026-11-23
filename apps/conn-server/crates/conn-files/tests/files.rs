//! Offline tests on real folders: reads, writes, listings, search, attachments and assets,
//! with every path escape (`..`, absolute paths, symlinks, `.git`, the server's own state).

#![expect(
    clippy::unwrap_used,
    reason = "test helpers: a failure should fail the test"
)]

use std::{
    fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    process::Command,
};

use conn_contract::{
    AssetResource, AssetsCreateUrlError, ChatAttachment, ChatImageAttachment,
    FilesystemBrowseInput, PersistChatAttachmentsInput, ProjectEntryKind,
    ProjectReadFileErrorFailure as Failure, ProjectReadFileInput, ProjectSearchContentsInput,
    ProjectSearchEntriesInput, ProjectWriteFileInput, UploadChatImageAttachment, from_json, lit,
};
use conn_files::{
    AssetContext, Files, KnownWorkspaces, Served,
    attachments::{UploadOutcome, UploadRequest, now_ms},
    entries, search, workspace,
};
use serde_json::json;

struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("conn-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(&path).unwrap())
    }

    fn write(&self, relative: &str, contents: impl AsRef<[u8]>) -> PathBuf {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        path
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A project, an outside folder and a server state folder side by side.
struct Fixture {
    _base: Dir,
    project: PathBuf,
    outside: PathBuf,
    state: PathBuf,
    files: Files,
}

fn fixture(name: &str) -> Fixture {
    let base = Dir::new(name);
    let project = base.0.join("project");
    let outside = base.0.join("outside");
    let state = base.0.join("state");
    for dir in [&project, &outside, &state] {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(outside.join("secret.txt"), "outside").unwrap();
    let files = Files::open(&state).unwrap();
    Fixture {
        _base: base,
        project,
        outside,
        state,
        files,
    }
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .status()
        .unwrap();
    assert!(status.success(), "git failed: {status}");
}

fn read(f: &Fixture, path: &str) -> Result<conn_contract::ProjectReadFileResult, Failure> {
    read_with(f, path, false)
}

fn read_with(
    f: &Fixture,
    path: &str,
    allow_missing: bool,
) -> Result<conn_contract::ProjectReadFileResult, Failure> {
    let input = ProjectReadFileInput {
        cwd: f.project.to_string_lossy().into_owned(),
        relative_path: path.into(),
        allow_missing: allow_missing.then_some(true),
    };
    workspace::read_file(&input, None, &f.files.internal).map_err(|e| e.failure)
}

#[test]
fn reads_stay_inside_the_root_and_out_of_server_state() {
    let f = fixture("read");
    fs::write(f.project.join("a.txt"), "hello").unwrap();
    assert_eq!(read(&f, "a.txt").unwrap().contents, "hello");
    assert_eq!(read(&f, "./sub/../a.txt").unwrap().relative_path, "a.txt");

    // `..` and a link out of the root.
    assert_eq!(
        read(&f, "../outside/secret.txt").unwrap_err(),
        Failure::WorkspacePathOutsideRoot
    );
    symlink(&f.outside, f.project.join("out")).unwrap();
    assert_eq!(
        read(&f, "out/secret.txt").unwrap_err(),
        Failure::ResolvedPathOutsideRoot
    );

    // An absolute path reads the host file in place, as the TypeScript server does...
    let secret = f.outside.join("secret.txt");
    assert_eq!(
        read(&f, &secret.to_string_lossy()).unwrap().contents,
        "outside"
    );
    // ...but never the server's own state, directly or through a link.
    let key = f.state.join("secrets/asset-signing-key");
    assert_eq!(
        read(&f, &key.to_string_lossy()).unwrap_err(),
        Failure::WorkspacePathOutsideRoot
    );
    symlink(&f.state, f.project.join("state-link")).unwrap();
    symlink(&f.state, f.outside.join("state-link")).unwrap();
    let via_link = f.outside.join("state-link/secrets/asset-signing-key");
    assert_eq!(
        read(&f, &via_link.to_string_lossy()).unwrap_err(),
        Failure::WorkspacePathOutsideRoot
    );
    // Network paths never reach the file system.
    assert_eq!(
        read(&f, "//host/share/x").unwrap_err(),
        Failure::WorkspacePathOutsideRoot
    );

    // Missing, binary, directory, truncated.
    assert_eq!(read_with(&f, "nope.txt", true).unwrap().exists, Some(false));
    assert_eq!(read(&f, "nope.txt").unwrap_err(), Failure::OperationFailed);
    fs::write(f.project.join("bin"), b"a\0b").unwrap();
    assert_eq!(read(&f, "bin").unwrap_err(), Failure::BinaryFile);
    fs::create_dir(f.project.join("dir")).unwrap();
    assert_eq!(read(&f, "dir").unwrap_err(), Failure::PathNotFile);
    let mut big = "é".repeat(600_000).into_bytes(); // 1.2 MB
    big.push(b'x');
    fs::write(f.project.join("big.txt"), &big).unwrap();
    let result = read(&f, "big.txt").unwrap();
    assert!(result.truncated);
    assert_eq!(result.byte_length, big.len() as i64);
    assert_eq!(result.contents.len(), 1024 * 1024);

    // T3 "rejects files with invalid UTF-8": U+FFFD would overwrite Latin-1 bytes on save.
    fs::write(f.project.join("latin1.txt"), b"name=caf\xe9\n").unwrap();
    assert_eq!(read(&f, "latin1.txt").unwrap_err(), Failure::BinaryFile);
    // An incomplete last character is invalid when the whole file was read.
    fs::write(f.project.join("cut.txt"), b"a\xe2\x82").unwrap();
    assert_eq!(read(&f, "cut.txt").unwrap_err(), Failure::BinaryFile);
    // T3 "drops a multibyte character split by the read limit".
    let mut split = vec![b'a'; 1024 * 1024 - 1];
    split.extend_from_slice("€\n".as_bytes());
    fs::write(f.project.join("split.txt"), &split).unwrap();
    let result = read(&f, "split.txt").unwrap();
    assert!(result.truncated);
    assert_eq!(result.byte_length, split.len() as i64);
    assert_eq!(result.contents, "a".repeat(1024 * 1024 - 1));
    // Invalid bytes before the limit are still refused.
    split[10] = 0xe9;
    fs::write(f.project.join("split.txt"), &split).unwrap();
    assert_eq!(read(&f, "split.txt").unwrap_err(), Failure::BinaryFile);
}

#[test]
fn writes_only_inside_known_workspaces_and_outside_git() {
    let f = fixture("write");
    git(&f.project, &["init", "-q"]);
    let projects = vec![f.project.to_string_lossy().into_owned()];
    let known = KnownWorkspaces::new(&projects, &[]);
    let write = |cwd: &Path, path: &str| {
        let input = ProjectWriteFileInput {
            cwd: cwd.to_string_lossy().into_owned(),
            relative_path: path.into(),
            contents: "x".into(),
        };
        workspace::write_file(&input, &|real| known.contains(real)).map_err(|e| e.failure)
    };
    assert_eq!(
        write(&f.project, "new/dir/a.txt").unwrap().relative_path,
        "new/dir/a.txt"
    );
    assert_eq!(
        fs::read_to_string(f.project.join("new/dir/a.txt")).unwrap(),
        "x"
    );

    assert_eq!(
        write(&f.outside, "a.txt").unwrap_err(),
        Failure::WorkspacePathOutsideRoot
    );
    assert_eq!(
        write(&f.project, "../outside/a.txt").unwrap_err(),
        Failure::WorkspacePathOutsideRoot
    );
    let absolute = f.outside.join("a.txt");
    assert_eq!(
        write(&f.project, &absolute.to_string_lossy()).unwrap_err(),
        Failure::WorkspacePathOutsideRoot
    );
    // A link to a folder outside, and a dangling link, cannot carry a new file out.
    symlink(&f.outside, f.project.join("out")).unwrap();
    assert_eq!(
        write(&f.project, "out/new.txt").unwrap_err(),
        Failure::ResolvedPathOutsideRoot
    );
    symlink(f.outside.join("missing"), f.project.join("dangling")).unwrap();
    assert_eq!(
        write(&f.project, "dangling/x.txt").unwrap_err(),
        Failure::OperationFailed
    );
    assert!(!f.outside.join("new.txt").exists() && !f.outside.join("missing").exists());
    // Git metadata, named or through a link.
    assert_eq!(
        write(&f.project, ".git/config").unwrap_err(),
        Failure::ResolvedPathOutsideRoot
    );
    symlink(f.project.join(".git"), f.project.join("meta")).unwrap();
    assert_eq!(
        write(&f.project, "meta/hooks/pre-commit").unwrap_err(),
        Failure::ResolvedPathOutsideRoot
    );
    // A file link swapped in at the target is not followed.
    symlink(f.outside.join("secret.txt"), f.project.join("swap.txt")).unwrap();
    assert!(write(&f.project, "swap.txt").is_err());
    assert_eq!(
        fs::read_to_string(f.outside.join("secret.txt")).unwrap(),
        "outside"
    );
}

#[test]
fn lists_folders_with_links_inside_and_ignored_marks() {
    let f = fixture("list");
    git(&f.project, &["init", "-q"]);
    let d = Dir(f.project.clone());
    d.write(".gitignore", "build/\n*.log\n");
    d.write("src/main.rs", "fn main() {}");
    d.write("build/out.js", "x");
    d.write("debug.log", "x");
    symlink(&f.outside, f.project.join("out")).unwrap();
    symlink(f.project.join("src"), f.project.join("src-link")).unwrap();
    symlink(&f.project, f.project.join("src/up")).unwrap();

    let listed = entries::list_directory(&f.project, "", &f.files.internal).unwrap();
    let mut names: Vec<(String, ProjectEntryKind, Option<bool>)> = listed
        .entries
        .into_iter()
        .map(|e| (e.path, e.kind, e.ignored))
        .collect();
    names.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        names,
        vec![
            (".gitignore".into(), ProjectEntryKind::File, None),
            ("build".into(), ProjectEntryKind::Directory, Some(true)),
            ("debug.log".into(), ProjectEntryKind::File, Some(true)),
            ("src".into(), ProjectEntryKind::Directory, None),
            ("src-link".into(), ProjectEntryKind::Directory, None),
        ],
        "the link out and .git are left out"
    );
    // A link back up to an ancestor is not offered as a folder.
    let src = entries::list_directory(&f.project, "src", &f.files.internal).unwrap();
    assert_eq!(src.entries.len(), 1, "{:?}", src.entries);
    for escape in ["..", "../outside", "out", ".git", "src/../.."] {
        assert!(
            entries::list_directory(&f.project, escape, &f.files.internal).is_err(),
            "{escape}"
        );
    }

    let all = entries::list_all(&f.project, &f.files.internal);
    let paths: Vec<&str> = all.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, [".gitignore", "src", "src/main.rs"]);
    let ignored = entries::list_ignored(&f.project, &f.files.internal, None);
    let ignored: Vec<&str> = ignored.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(ignored, ["debug.log"], "build/ is a wholly ignored folder");
}

/// T3's WorkspaceEntries test: a query finds ignored files that sort past the 200 cap.
#[test]
fn a_query_finds_ignored_files_past_the_listing_limit() {
    let f = fixture("ignored-query");
    git(&f.project, &["init", "-q"]);
    let d = Dir(f.project.clone());
    d.write(".gitignore", "*.secret\n");
    for index in 1..=205 {
        d.write(&format!("file-{index:03}.secret"), "s");
    }
    let all = entries::list_ignored(&f.project, &f.files.internal, None);
    assert!(all.truncated, "205 files pass the cap");
    assert!(!all.files.iter().any(|f| f.path == "file-205.secret"));
    let found = entries::list_ignored(&f.project, &f.files.internal, Some("FILE-205"));
    let paths: Vec<(&str, i64)> = found
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.byte_length))
        .collect();
    assert_eq!(
        paths,
        [("file-205.secret", 1)],
        "case-insensitive, before the cap"
    );
    assert!(!found.truncated);
}

#[test]
fn searches_names_and_contents_without_ignored_files() {
    let f = fixture("search");
    git(&f.project, &["init", "-q"]);
    let d = Dir(f.project.clone());
    d.write(".gitignore", "dist/\n");
    d.write(
        "src/server/main.rs",
        "fn main() {\n    let MainLoop = 1; // mainly\n}\n",
    );
    d.write("src/client/app.ts", "export const main = 'Main';\n");
    d.write("dist/main.js", "main main main");
    d.write("logo.png", b"\x89PNG\0\0");

    let names = |query: &str, kind: Option<ProjectEntryKind>, image_only: bool| {
        let input = ProjectSearchEntriesInput {
            cwd: String::new(),
            query: query.into(),
            limit: 10,
            kind,
            image_only: image_only.then_some(true),
        };
        search::search_entries(&f.project, &input, &f.files.internal)
            .entries
            .into_iter()
            .map(|e| e.path)
            .collect::<Vec<_>>()
    };
    let found = names("main", None, false);
    assert_eq!(found[0], "src/server/main.rs", "{found:?}");
    assert!(!found.iter().any(|p| p.starts_with("dist")), "{found:?}");
    assert_eq!(
        names("srv", Some(ProjectEntryKind::Directory), false),
        ["src/server"]
    );
    assert_eq!(names("", None, true), ["logo.png"]);
    assert_eq!(names("*.ts", None, false), ["src/client/app.ts"]);

    let grep = |query: &str, case: bool, word: bool, regex: bool| {
        let input = ProjectSearchContentsInput {
            cwd: String::new(),
            query: query.into(),
            limit: 50,
            case_sensitive: case,
            whole_word: word,
            use_regex: regex,
        };
        search::search_contents(&f.project, &input, &f.files.internal)
    };
    let all = grep("main", false, false, false);
    assert_eq!(all.matches.len(), 3, "{:?}", all.matches);
    assert!(all.matches.iter().all(|m| !m.path.starts_with("dist")));
    let words = grep("main", false, true, false);
    let mut word_lines: Vec<(String, i64)> = words
        .matches
        .iter()
        .map(|m| (m.path.clone(), m.line_number))
        .collect();
    word_lines.sort();
    assert_eq!(
        word_lines,
        [
            ("src/client/app.ts".into(), 1),
            ("src/server/main.rs".into(), 1)
        ]
    );
    let app = words
        .matches
        .iter()
        .find(|m| m.path.ends_with("app.ts"))
        .unwrap();
    assert_eq!(app.match_ranges.len(), 2, "main and Main");
    assert_eq!(
        (app.match_ranges[0].start, app.match_ranges[0].end),
        (13, 17)
    );
    assert_eq!(grep("Main", true, false, false).matches.len(), 2);
    assert_eq!(grep(r"Main\w+", true, false, true).matches.len(), 1);
    let broken = grep("(main", false, false, true);
    assert!(broken.regex_fallback_error.is_some());
    assert!(broken.matches.is_empty());
}

#[test]
fn browses_folders_for_the_project_picker() {
    let f = fixture("browse");
    for d in ["alpha", "Beta", ".hidden", "alpine"] {
        fs::create_dir(f.project.join(d)).unwrap();
    }
    fs::write(f.project.join("afile"), "").unwrap();
    let browse = |partial: String, cwd: Option<String>| {
        workspace::browse(
            &FilesystemBrowseInput {
                partial_path: partial,
                cwd,
            },
            None,
        )
    };
    let root = f.project.to_string_lossy().into_owned();
    let names = |r: conn_contract::FilesystemBrowseResult| {
        r.entries.into_iter().map(|e| e.name).collect::<Vec<_>>()
    };
    assert_eq!(
        names(browse(format!("{root}/al"), None).unwrap()),
        ["alpha", "alpine"]
    );
    assert_eq!(
        names(browse(format!("{root}/"), None).unwrap()),
        [".hidden", "alpha", "alpine", "Beta"]
    );
    assert_eq!(
        names(browse("./b".into(), Some(root.clone())).unwrap()),
        ["Beta"]
    );
    assert!(browse("./x".into(), None).is_err());
    let missing = browse(format!("{root}/nope/"), None).unwrap_err();
    assert_eq!(missing.path_missing, Some(true));
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[0; 16]);
    bytes
}

fn upload(f: &Fixture, kind: Option<&str>, name: &str, mime: &str, bytes: &[u8]) -> String {
    let request = UploadRequest {
        kind: kind.map(str::to_owned),
        name: name.into(),
        mime_type: mime.into(),
        size_bytes: bytes.len() as u64,
    };
    request.validate().unwrap();
    let issued = f
        .files
        .attachments
        .create_upload(&f.files.signer, &request, now_ms());
    let token = issued
        .relative_url
        .strip_prefix("/api/attachments/upload/")
        .unwrap();
    let claims = f
        .files
        .attachments
        .verify_upload(&f.files.signer, token, now_ms())
        .unwrap();
    let (part, target) = f.files.attachments.upload_paths(&claims).unwrap();
    fs::write(&part, bytes).unwrap();
    let outcome =
        f.files
            .attachments
            .publish_upload(&part, &target, bytes.len() as u64, claims.size_bytes);
    assert_eq!(outcome, UploadOutcome::Stored, "the upload is published");
    assert!(!part.exists(), "the part file is gone after publish");
    issued.attachment_id
}

#[test]
fn uploads_claims_and_deletes_attachments() {
    let f = fixture("attach");
    let image = png(3, 2);
    let id = upload(&f, None, "shot.png", "image/png", &image);
    assert!(id.starts_with("pending-"));
    let stored = f.files.attachments.resolve(&id).unwrap();
    assert_eq!(stored.extension, ".png");
    assert_eq!(stored.byte_length, image.len() as u64);
    assert_eq!(stored.mime_type, Some("image/png"));
    assert!(stored.path.starts_with(f.files.attachments.dir()));

    // Tokens: tampered, expired, wrong size.
    let request = UploadRequest {
        kind: Some("file".into()),
        name: "notes.pdf".into(),
        mime_type: "application/pdf".into(),
        size_bytes: 4,
    };
    let issued = f
        .files
        .attachments
        .create_upload(&f.files.signer, &request, now_ms());
    assert!(issued.attachment_id.ends_with("-pdf"));
    let token = issued.relative_url.rsplit('/').next().unwrap().to_owned();
    let store = &f.files.attachments;
    assert!(
        store
            .verify_upload(&f.files.signer, &token, now_ms() + 11 * 60_000)
            .is_none()
    );
    let mut forged = token.clone();
    forged.insert(3, 'A');
    assert!(
        store
            .verify_upload(&f.files.signer, &forged, now_ms())
            .is_none()
    );
    let claims = store
        .verify_upload(&f.files.signer, &token, now_ms())
        .unwrap();
    let (part, target) = store.upload_paths(&claims).unwrap();
    fs::write(&part, b"abc").unwrap();
    assert!(matches!(
        store.publish_upload(&part, &target, 3, 4),
        UploadOutcome::Rejected { status: 400, .. }
    ));
    assert!(store.resolve(&issued.attachment_id).is_none());
    // Contract limits.
    let too_big = UploadRequest {
        size_bytes: 11 * 1024 * 1024,
        ..request_image()
    };
    assert!(too_big.validate().is_err());

    // Ids that would leave the store resolve to nothing.
    for bad in [
        "../state/secrets/asset-signing-key",
        "/etc/passwd",
        "pending-x",
        "",
    ] {
        assert!(store.resolve(bad).is_none(), "{bad}");
    }

    // Claim for a thread: a copy under the thread's id; the pending file stays for a retry.
    let attachment = ChatAttachment::Image(ChatImageAttachment {
        r#type: lit::Image,
        id: id.clone(),
        name: "shot.png".into(),
        mime_type: "IMAGE/PNG".into(),
        size_bytes: image.len() as i64,
        source: None,
    });
    let ChatAttachment::Image(claimed) = store.claim("Thread 1", &attachment).unwrap() else {
        panic!()
    };
    assert!(claimed.id.starts_with("thread-1-"), "{}", claimed.id);
    assert_eq!(claimed.mime_type, "image/png");
    assert_eq!(
        fs::read(store.resolve(&claimed.id).unwrap().path).unwrap(),
        image
    );
    let wrong_size = match &attachment {
        ChatAttachment::Image(a) => ChatAttachment::Image(ChatImageAttachment {
            size_bytes: 1,
            ..a.clone()
        }),
        _ => unreachable!(),
    };
    assert!(store.claim("t", &wrong_size).unwrap_err().contains("size"));
    store.release(&[ChatAttachment::Image(claimed.clone())]);
    assert!(store.resolve(&claimed.id).is_none());

    let missing = ChatAttachment::Image(ChatImageAttachment {
        id: format!("pending-{}", conn_support::uuid_v4()),
        ..match &attachment {
            ChatAttachment::Image(a) => a.clone(),
            _ => unreachable!(),
        }
    });
    let before = fs::read_dir(store.dir()).unwrap().count();
    assert!(
        store
            .claim_all("Thread 1", &[attachment.clone(), missing])
            .unwrap_err()
            .contains("not found")
    );
    assert_eq!(
        fs::read_dir(store.dir()).unwrap().count(),
        before,
        "failed batch must release its claimed copies"
    );

    // Delete removes pending uploads only.
    store.delete_pending(&id);
    assert!(store.resolve(&id).is_none());

    // The sweep: old pending uploads and parts go, thread attachments stay.
    let kept = upload(&f, None, "b.png", "image/png", &image);
    let ChatAttachment::Image(thread_copy) = store
        .claim(
            "t",
            &ChatAttachment::Image(ChatImageAttachment {
                id: kept.clone(),
                ..match &attachment {
                    ChatAttachment::Image(a) => a.clone(),
                    _ => unreachable!(),
                }
            }),
        )
        .unwrap()
    else {
        panic!()
    };
    fs::write(store.dir().join("x.png.1.part"), b"").unwrap();
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(25 * 60 * 60);
    assert_eq!(store.sweep(later), 2);
    assert!(store.resolve(&kept).is_none());
    assert!(store.resolve(&thread_copy.id).is_some());
}

fn request_image() -> UploadRequest {
    UploadRequest {
        kind: None,
        name: "a.png".into(),
        mime_type: "image/png".into(),
        size_bytes: 1,
    }
}

#[test]
fn persists_data_url_images_with_stable_ids() {
    let f = fixture("persist");
    let input = PersistChatAttachmentsInput {
        thread_id: "t1".into(),
        message_id: "m1".into(),
        attachments: vec![UploadChatImageAttachment {
            id: None,
            r#type: lit::Image,
            name: "a.png".into(),
            mime_type: "image/png".into(),
            size_bytes: 2,
            data_url: "data:image/png;base64,aGk=".into(),
            source: None,
        }],
    };
    let first = f.files.attachments.persist_data_urls(&input).unwrap();
    let again = f.files.attachments.persist_data_urls(&input).unwrap();
    assert_eq!(first, again, "a retry keeps its ids");
    let ChatAttachment::Image(image) = &first[0] else {
        panic!()
    };
    assert!(image.id.starts_with("t1-"));
    assert_eq!(
        fs::read(f.files.attachments.resolve(&image.id).unwrap().path).unwrap(),
        b"hi"
    );
    let mut bad = input;
    bad.attachments[0].size_bytes = 3;
    assert!(f.files.attachments.persist_data_urls(&bad).is_err());
    bad.attachments[0].data_url = "data:image/jpeg;base64,aGk=".into();
    assert!(f.files.attachments.persist_data_urls(&bad).is_err());
}

fn resource(value: serde_json::Value) -> AssetResource {
    from_json(value).unwrap()
}

fn token_and_name(url: &str) -> (String, String) {
    let rest = url.strip_prefix("/api/assets/").unwrap();
    let (token, name) = rest.split_once('/').unwrap();
    (token.into(), name.into())
}

fn served_path(served: Option<Served>) -> Option<PathBuf> {
    match served? {
        Served::File { path, .. } => Some(path),
        Served::Bytes { .. } => None,
    }
}

#[test]
fn signs_asset_urls_and_rechecks_them_when_served() {
    let f = fixture("assets");
    let d = Dir(f.project.clone());
    d.write("img/a.png", png(4, 3));
    d.write("docs/page.html", "<script src='app.js'></script>");
    d.write("docs/app.js", "1");
    d.write("docs/.env.js", "secret");
    d.write("src/code.rs", "fn x() {}");
    let root = Some(f.project.to_string_lossy().into_owned());
    let context = AssetContext {
        workspace_root: root,
        project_favicon_path: None,
    };
    let now = now_ms();

    let image = f
        .files
        .create_asset_url(
            &resource(json!({"_tag": "workspace-file", "threadId": "t", "path": "img/a.png"})),
            &context,
            now,
        )
        .unwrap();
    assert_eq!(
        image.image_dimensions.map(|d| (d.width, d.height)),
        Some((4, 3))
    );
    let (token, name) = token_and_name(&image.relative_url);
    assert_eq!(name, "a.png");
    assert_eq!(
        served_path(f.files.resolve_asset(&token, &name, now)),
        Some(f.project.join("img/a.png"))
    );
    assert!(f.files.resolve_asset(&token, "other.png", now).is_none());
    assert!(
        f.files
            .resolve_asset(&token, &name, now + 2 * 3600 * 1000)
            .is_none(),
        "expired"
    );
    let (payload, signature) = token.split_once('.').unwrap();
    assert!(
        f.files
            .resolve_asset(&format!("{payload}x.{signature}"), &name, now)
            .is_none()
    );
    // The file swapped for a link out after minting is not served.
    fs::remove_file(f.project.join("img/a.png")).unwrap();
    symlink(f.outside.join("secret.txt"), f.project.join("img/a.png")).unwrap();
    assert!(f.files.resolve_asset(&token, &name, now).is_none());

    // Source files are not previews; `..` and absolute escapes are refused at mint.
    let mint = |value: serde_json::Value| f.files.create_asset_url(&resource(value), &context, now);
    assert!(matches!(
        mint(json!({"_tag": "workspace-file", "threadId": "t", "path": "src/code.rs"})),
        Err(AssetsCreateUrlError::AssetPreviewTypeValidationError(_))
    ));
    assert!(matches!(
        mint(json!({"_tag": "workspace-file", "threadId": "t", "path": "../outside/x.png"})),
        Err(AssetsCreateUrlError::AssetWorkspacePathValidationError(_))
    ));

    // An HTML page grants its folder's scripts, never hidden files or `..`.
    let page =
        mint(json!({"_tag": "workspace-file", "threadId": "t", "path": "docs/page.html"})).unwrap();
    let (token, _) = token_and_name(&page.relative_url);
    assert_eq!(
        served_path(f.files.resolve_asset(&token, "app.js", now)),
        Some(f.project.join("docs/app.js"))
    );
    for denied in [".env.js", "..%2Fimg%2Fa.png", "../img/a.png", "app.rs"] {
        assert!(
            f.files.resolve_asset(&token, denied, now).is_none(),
            "{denied}"
        );
    }

    // Host media by absolute path: served, pinned; the server's state is not.
    fs::write(f.outside.join("clip.mp4"), b"mp4").unwrap();
    let clip = f.outside.join("clip.mp4");
    let media = mint(json!({"_tag": "media-file", "threadId": "t", "path": clip})).unwrap();
    assert!(media.file_revision.is_some());
    let (token, name) = token_and_name(&media.relative_url);
    assert_eq!(
        served_path(f.files.resolve_asset(&token, &name, now)),
        Some(clip)
    );
    let key = f.state.join("secrets/asset-signing-key");
    assert!(
        mint(
            json!({"_tag": "media-file", "threadId": "t", "path": key, "disposition": "attachment"})
        )
        .is_err()
    );

    // Attachments.
    let id = upload(&f, None, "s.png", "image/png", &png(5, 6));
    let asset = mint(json!({"_tag": "attachment", "attachmentId": id})).unwrap();
    assert_eq!(
        asset.image_dimensions.map(|d| (d.width, d.height)),
        Some((5, 6))
    );
    let (token, name) = token_and_name(&asset.relative_url);
    assert!(served_path(f.files.resolve_asset(&token, &name, now)).is_some());
    for extension in ["html", "pdf"] {
        let id = upload(
            &f,
            Some("file"),
            &format!("app.{extension}"),
            "application/octet-stream",
            b"capture",
        );
        for disposition in ["inline", "attachment"] {
            let asset = mint(json!({"_tag":"attachment","attachmentId":id,"disposition":disposition,"renderIntent":"mcp-app"})).unwrap();
            let (token, name) = token_and_name(&asset.relative_url);
            let served = f.files.resolve_asset(&token, &name, now).unwrap();
            let Served::File { render_intent, .. } = served else {
                panic!("expected file");
            };
            assert_eq!(
                render_intent.is_some(),
                extension == "html" && disposition == "inline"
            );
            let (body, signature) = token.split_once('.').unwrap();
            let mut claims: serde_json::Value =
                serde_json::from_slice(&conn_support::base64::url_decode(body).unwrap()).unwrap();
            claims["renderIntent"] = json!(if render_intent.is_some() {
                "other"
            } else {
                "mcp-app"
            });
            let changed = format!(
                "{}.{signature}",
                conn_support::base64::url_encode(claims.to_string().as_bytes())
            );
            assert!(f.files.resolve_asset(&changed, &name, now).is_none());
        }
    }
    assert!(matches!(
        mint(json!({"_tag": "attachment", "attachmentId": "pending-../../x"})),
        Err(AssetsCreateUrlError::AssetAttachmentNotFoundError(_))
    ));
}

#[test]
fn finds_project_favicons() {
    let f = fixture("favicon");
    let d = Dir(f.project.clone());
    let cwd = f.project.to_string_lossy().into_owned();
    let mint = |files: &Files| {
        files.create_asset_url(
            &resource(json!({"_tag": "project-favicon", "cwd": cwd})),
            &AssetContext::default(),
            now_ms(),
        )
    };
    let missing = mint(&f.files).unwrap();
    assert!(missing.relative_url.ends_with("/project-favicon-missing"));
    d.write("index.html", r#"<link rel="icon" href="/brand.svg">"#);
    d.write("public/brand.svg", "<svg/>");
    let found = mint(&f.files).unwrap();
    assert_eq!(found.source_path.as_deref(), Some("public/brand.svg"));
    assert!(found.relative_url.contains("/v"), "{}", found.relative_url);
    let (token, name) = token_and_name(&found.relative_url);
    assert_eq!(
        served_path(f.files.resolve_asset(&token, &name, now_ms())),
        Some(f.project.join("public/brand.svg"))
    );
    d.write("favicon.png", png(1, 1));
    assert_eq!(
        mint(&f.files).unwrap().source_path.as_deref(),
        Some("favicon.png")
    );
}

#[test]
fn serves_a_published_theme_background_and_nothing_else() {
    let f = fixture("theme-background");
    let themes = f.state.join("themes");
    let now = now_ms();
    let mint = |id: &str| {
        f.files.create_asset_url(
            &resource(json!({"_tag": "environment-theme-background", "themeId": id})),
            &AssetContext::default(),
            now,
        )
    };
    let issued = mint("night").unwrap();
    let (token, name) = token_and_name(&issued.relative_url);
    assert_eq!(name, "night-background");
    // No image yet: the URL is minted, the route answers 404.
    assert!(f.files.resolve_asset(&token, &name, now).is_none());
    fs::write(themes.join("night.jpg"), "jpg").unwrap();
    let real_themes = fs::canonicalize(&themes).unwrap();
    assert_eq!(
        served_path(f.files.resolve_asset(&token, &name, now)),
        Some(real_themes.join("night.jpg"))
    );
    // The route serves only the file with the inode checked here, not a link swapped in later.
    let Some(Served::File { identity, .. }) = f.files.resolve_asset(&token, &name, now) else {
        panic!("no background served");
    };
    let inode =
        std::os::unix::fs::MetadataExt::ino(&fs::metadata(themes.join("night.jpg")).unwrap());
    assert_eq!(identity.map(|(_, ino)| ino), Some(inode));
    // Earlier extensions win; a link is never served.
    fs::write(themes.join("night.webp"), "webp").unwrap();
    assert_eq!(
        served_path(f.files.resolve_asset(&token, &name, now)),
        Some(real_themes.join("night.webp"))
    );
    fs::remove_file(themes.join("night.webp")).unwrap();
    fs::remove_file(themes.join("night.jpg")).unwrap();
    symlink(f.outside.join("secret.txt"), themes.join("night.png")).unwrap();
    assert!(f.files.resolve_asset(&token, &name, now).is_none());
    // Ids T3's schema refuses never reach the folder.
    assert!(mint("../secrets").is_err());
    assert!(mint("Night").is_err());
}
