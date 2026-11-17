use super::*;

async fn running_parent(f: &Fixture) -> (Value, Caller) {
    let mut c = Client::open(&f.service, client(true)).await;
    let parent = c
        .ok(
            "t3_thread_launch",
            json!({
                "projectId": project_id(), "title": "Parent", "message": "hang",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
                "runtimeMode": "auto",
            }),
        )
        .await;
    let caller = Caller::Thread(ThreadCaller {
        thread_id: parent["threadId"].as_str().unwrap().to_owned(),
        provider_session_id: "handoff-session".into(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,
        preview: true,
    });
    (parent, caller)
}

#[tokio::test(flavor = "current_thread")]
async fn create_threads_inherits_checkout_records_timeline_and_retries() {
    let f = fixture("batch-threads");
    let (parent, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    let input =
        json!({"threads": [{"title": "One"}, {"prompt": "hello"}, {}], "clientRequestId": "batch"});
    let first = agent.ok("create_threads", input.clone()).await;
    let retry = agent.ok("create_threads", input).await;
    assert_eq!(
        first["threads"][0]["threadId"],
        retry["threads"][0]["threadId"]
    );
    for (index, child) in first["threads"].as_array().unwrap().iter().enumerate() {
        let projection = f
            .service
            .config
            .engine
            .get_thread_projection(child["threadId"].as_str().unwrap().into())
            .await
            .unwrap();
        assert_eq!(projection["thread"]["projectId"], project_id());
        assert_eq!(
            projection["thread"]["lineage"]["relationshipToParent"],
            Value::Null
        );
        assert_eq!(projection["thread"]["runtimeMode"], "auto");
        assert_eq!(
            projection["runs"].as_array().unwrap().len(),
            usize::from(index == 1),
            "retry duplicated child {index}"
        );
    }
    let upgraded = json!({"threads":[{"prompt":"hang"}],"clientRequestId":"idle-upgrade"});
    agent
        .ok(
            "create_threads",
            json!({"threads":[{}],"clientRequestId":"idle-upgrade"}),
        )
        .await;
    let started = agent.ok("create_threads", upgraded.clone()).await;
    agent.ok("create_threads", upgraded).await;
    let projection = f
        .service
        .config
        .engine
        .get_thread_projection(started["threads"][0]["threadId"].as_str().unwrap().into())
        .await
        .unwrap();
    assert_eq!(projection["runs"].as_array().unwrap().len(), 1);
    assert_eq!(first["threads"][0]["status"], "idle");
    assert_eq!(first["threads"][2]["title"], "Parent thread 3");
    let parent = f
        .service
        .config
        .engine
        .get_thread_projection(parent["threadId"].as_str().unwrap().into())
        .await
        .unwrap();
    assert_eq!(
        parent["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["type"] == "thread_created")
            .count(),
        4
    );
    let (code, _) = agent
        .failure(
            "create_threads",
            json!({"threads":[{"runtimeMode":"full-access"}]}),
        )
        .await;
    assert_eq!(code, "runtime_mode_escalation_denied");
}

#[tokio::test(flavor = "current_thread")]
async fn attachment_upload_is_owned_by_preparing_caller() {
    let f = fixture("upload-owner");
    let mut c = Client::open(&f.service, client(true)).await;
    let upload = c.ok("t3_attachment_prepare_upload", json!({"upload":{"type":"file", "name":"a.txt", "mimeType":"text/plain", "sizeBytes":3}})).await;
    assert!(
        upload["attachmentId"]
            .as_str()
            .unwrap()
            .starts_with("pending-")
    );
    let mut other = Client::open(
        &f.service,
        Caller::Client(ClientCaller {
            session_id: "other".into(),
            max_runtime_mode: Some("full-access"),
        }),
    )
    .await;
    assert_eq!(
        other
            .failure(
                "t3_attachment_discard",
                json!({"attachmentId":upload["attachmentId"]})
            )
            .await
            .0,
        "invalid_request"
    );
    c.ok(
        "t3_attachment_discard",
        json!({"attachmentId":upload["attachmentId"]}),
    )
    .await;
    assert_eq!(
        c.failure(
            "t3_attachment_discard",
            json!({"attachmentId":upload["attachmentId"]})
        )
        .await
        .0,
        "invalid_request"
    );
    let mut reader = Client::open(&f.service, client(false)).await;
    assert_eq!(
        reader
            .failure(
                "t3_attachment_prepare_upload",
                json!({"upload":{"name":"a.png", "mimeType":"image/png", "sizeBytes":3}})
            )
            .await
            .0,
        "capability_denied"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn worktree_status_is_readable_after_caller_stops_and_hidden_outside() {
    let f = fixture("worktree-status");
    let mut c = Client::open(&f.service, client(true)).await;
    for tool in [
        "create_threads",
        "t3_worktree_status",
        "t3_worktree_handoff",
    ] {
        not_offered(&mut c, tool, json!({})).await;
    }
    let (parent, caller) = running_parent(&f).await;
    c.ok(
        "t3_thread_interrupt",
        json!({"threadId":parent["threadId"]}),
    )
    .await;
    c.ok(
        "t3_thread_wait",
        json!({"threadId":parent["threadId"],"timeoutMs":10000}),
    )
    .await;
    let mut agent = Client::open(&f.service, caller).await;
    let status = agent.ok("t3_worktree_status", json!({})).await;
    assert_eq!(status["attached"], false);
    assert_eq!(status["projectWorkspaceRoot"], ROOT);
    assert_eq!(status["defaultStartFromOrigin"], true);
}

pub(super) struct FilesHost(pub Arc<conn_files::Files>);
impl conn_engine::EngineHost for FilesHost {
    fn claim_attachments(
        &self,
        thread: String,
        attachments: Value,
    ) -> conn_engine::BoxFuture<'_, Result<Value, String>> {
        let files = self.0.clone();
        Box::pin(async move {
            let list: Vec<conn_contract::ChatAttachment> =
                conn_contract::from_json(attachments).map_err(|e| e.to_string())?;
            tokio::task::spawn_blocking(move || {
                files
                    .attachments
                    .claim_all(&thread, &list)
                    .map(|list| conn_contract::to_json(&list))
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }
}

fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

async fn git_project(f: &Fixture) -> PathBuf {
    let root = f.dir.join("repo");
    let path = root.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&path).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec![
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        ] {
            git(&path, &args);
        }
    })
    .await
    .unwrap();
    f.service
        .config
        .engine
        .call(
            "projects.mutate",
            json!({"type":"project.update","projectId":project_id(),"workspaceRoot":root}),
        )
        .await
        .unwrap();
    root
}

#[tokio::test(flavor = "current_thread")]
async fn attachments_claim_bytes_reuse_canonical_metadata_and_refuse_foreign_ids() {
    let f = fixture("attachment-send");
    let (parent, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    let prepared = agent.ok("t3_attachment_prepare_upload",json!({"upload":{"type":"file","name":"note.txt","mimeType":"text/plain","sizeBytes":3}})).await;
    let files = f.service.config.files.clone().unwrap();
    let id = prepared["attachmentId"].as_str().unwrap().to_owned();
    let token = prepared["relativeUrl"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let claims = files
        .attachments
        .verify_upload(&files.signer, token, conn_files::attachments::now_ms())
        .unwrap();
    let (part, target) = files.attachments.upload_paths(&claims).unwrap();
    std::fs::write(&part, b"abc").unwrap();
    assert!(matches!(
        files
            .attachments
            .publish_upload(&part, &target, 3, claims.size_bytes),
        conn_files::attachments::UploadOutcome::Stored
    ));
    f.service.config.engine.dispatch(conn_contract::from_json(json!({
        "type":"thread.create","commandId":"attachment-first-message","threadId":"atomic-attachments",
        "projectId":project_id(),"title":"Atomic attachment","modelSelection":{"instanceId":"claudeAgent","model":"claude-haiku-5-5"},
        "runtimeMode":"auto","interactionMode":"default","branch":null,"worktreePath":null,"createdBy":"agent","creationSource":"mcp",
        "initialMessage":{"messageId":"atomic-file","text":"hello","attachments":[{"type":"file","id":id,"name":"note.txt","mimeType":"text/plain","sizeBytes":3}]},
    })).unwrap()).await.unwrap();
    let atomic = f
        .service
        .config
        .engine
        .get_thread_projection("atomic-attachments".into())
        .await
        .unwrap();
    assert_ne!(atomic["messages"][0]["attachments"][0]["id"], id);
    assert!(
        files
            .attachments
            .resolve(
                atomic["messages"][0]["attachments"][0]["id"]
                    .as_str()
                    .unwrap()
            )
            .is_some()
    );
    let duplicate =
        json!({"type":"file","id":id,"name":"note.txt","mimeType":"text/plain","sizeBytes":3});
    assert_eq!(
        agent
            .failure(
                "t3_thread_send_attachments",
                json!({"attachments":[duplicate.clone(),duplicate]})
            )
            .await,
        (
            "orchestration_error".into(),
            "Duplicate attachment ids are not allowed.".into()
        )
    );
    let images: Vec<_> = (0..2).map(|n|json!({"type":"file","id":format!("pending-00000000-0000-4000-8000-{n:012}"),"name":"photo.png","mimeType":"image/png","sizeBytes":50*1024*1024})).collect();
    assert_eq!(agent.failure("t3_thread_send_attachments", json!({"attachments":images})).await,
        ("orchestration_error".into(), "Images can total up to 80 MiB per message or question response. Use smaller images or send fewer at once.".into()));
    let result = agent.ok("t3_thread_send_attachments",json!({"attachments":[{"type":"file","id":id,"name":"note.txt","mimeType":"text/plain","sizeBytes":3}]})).await;
    let projection = f
        .service
        .config
        .engine
        .get_thread_projection(parent["threadId"].as_str().unwrap().into())
        .await
        .unwrap();
    let message = projection["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == result["messageId"])
        .unwrap();
    let attachment = &message["attachments"][0];
    assert_ne!(attachment["id"], id);
    assert_eq!(
        crate::lock(&f.service.upload_owners).pending_count(),
        0,
        "claimed owners consume pending capacity"
    );
    assert_eq!(message["senderThreadId"], parent["threadId"]);
    let stored = files
        .attachments
        .resolve(attachment["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(std::fs::read(stored.path).unwrap(), b"abc");
    let mut tampered = attachment.clone();
    tampered["name"] = json!("forged.txt");
    // Steering may end the parent; its paired client can still reuse the attachments.
    let mut outside = Client::open(&f.service, client(true)).await;
    let reused = outside
        .ok(
            "t3_thread_send_attachments",
            json!({"threadId":parent["threadId"],"attachments":[tampered]}),
        )
        .await;
    let projection = f
        .service
        .config
        .engine
        .get_thread_projection(parent["threadId"].as_str().unwrap().into())
        .await
        .unwrap();
    let message = projection["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == reused["messageId"])
        .unwrap();
    assert_eq!(message["attachments"][0]["name"], "note.txt");
    let mut foreign = attachment.clone();
    foreign["id"] = json!("other-00000000-0000-4000-8000-000000000001-txt");
    assert_eq!(
        outside
            .failure(
                "t3_thread_send_attachments",
                json!({"threadId":parent["threadId"],"attachments":[foreign]})
            )
            .await
            .0,
        "invalid_request"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn handoff_moves_thread_ends_old_run_and_resumes_in_worktree() {
    let f = fixture("handoff-resume");
    let root = git_project(&f).await;
    let (parent, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    let moved = agent.ok("t3_worktree_handoff",json!({"branch":"feature/handoff","startFromOrigin":false,"continuationPrompt":"write handoff-proof.txt hello"})).await;
    assert_eq!(moved["startedFromOrigin"], false);
    assert_eq!(moved["setupScript"]["status"], "no-script");
    assert_eq!(moved["continuation"]["status"], "scheduled");
    let status = agent.ok("t3_worktree_status", json!({})).await;
    assert_eq!(status["branch"], "feature/handoff");
    assert_eq!(status["worktreePath"], moved["worktreePath"]);
    assert_eq!(
        status["projectWorkspaceRoot"],
        root.to_string_lossy().as_ref()
    );
    let refs = agent.ok("t3_worktree_list", json!({})).await;
    assert!(
        refs["refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["name"] == "feature/handoff" && r["worktreePath"] == moved["worktreePath"])
    );
    let mut c = Client::open(&f.service, client(true)).await;
    c.ok(
        "t3_thread_wait",
        json!({"threadId":parent["threadId"],"timeoutMs":10000}),
    )
    .await;
    let projection = f
        .service
        .config
        .engine
        .get_thread_projection(parent["threadId"].as_str().unwrap().into())
        .await
        .unwrap();
    assert_eq!(projection["runs"][0]["status"], "completed");
    assert_eq!(projection["runs"][1]["status"], "completed");
    assert_eq!(
        std::fs::read_to_string(
            PathBuf::from(moved["worktreePath"].as_str().unwrap()).join("handoff-proof.txt")
        )
        .unwrap(),
        "hello\n"
    );
    assert!(!root.join("handoff-proof.txt").exists());
    // A second handoff must not leave a second branch or checkout.
    let error = agent
        .failure("t3_worktree_handoff", json!({"branch":"feature/again"}))
        .await;
    assert_eq!(error.0, "parent_not_active");
    c.ok(
        "t3_thread_organize",
        json!({"threadId":parent["threadId"],"action":"archive"}),
    )
    .await;
    assert!(PathBuf::from(moved["worktreePath"].as_str().unwrap()).exists());
}

#[tokio::test(flavor = "current_thread")]
async fn nested_inputs_validate_before_access_and_trim_as_t3() {
    let f = fixture("handoff-input");
    let (_, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    for (tool, input, path, expected) in [
        (
            "t3_worktree_list",
            json!({"threadId":" "}),
            "[\"threadId\"]",
            "a non-blank string",
        ),
        (
            "t3_worktree_list",
            json!({"query":"x".repeat(257)}),
            "[\"query\"]",
            "a value with a length of at most 256",
        ),
        (
            "create_threads",
            json!({"threads":[{"title":" "}]}),
            "[\"threads\"][0][\"title\"]",
            "a non-blank string",
        ),
        (
            "create_threads",
            json!({"threads":[{"prompt":"x".repeat(120001)}]}),
            "[\"threads\"][0][\"prompt\"]",
            "a value with a length of at most 120000",
        ),
        (
            "t3_worktree_handoff",
            json!({"branch":" "}),
            "[\"branch\"]",
            "a non-blank string",
        ),
        (
            "t3_attachment_prepare_upload",
            json!({"upload":{"name":"shot.png","mimeType":"image/png","sizeBytes":0}}),
            "[\"upload\"][\"sizeBytes\"]",
            "a value greater than or equal to 1",
        ),
    ] {
        let reply = agent
            .request("tools/call", json!({"name":tool,"arguments":input}))
            .await;
        assert_eq!(reply["error"]["code"], -32602, "{reply}");
        assert_eq!(
            reply["error"]["message"],
            format!("Invalid parameters for tool '{tool}': Expected {expected}\n  at {path}")
        );
    }
    let created = agent.ok("create_threads",json!({"threads":[{"title":"  Trim me  ","target":{"providerInstanceId":" claudeAgent "}}]})).await;
    assert_eq!(created["threads"][0]["title"], "Trim me");
    let omitted = agent
        .ok(
            "create_threads",
            json!({"threads":[{"title":null,"target":{"providerInstanceId":null}}]}),
        )
        .await;
    assert_eq!(omitted["threads"][0]["title"], "Parent thread 1");
}

#[tokio::test(flavor = "current_thread")]
async fn metadata_binding_rejects_stale_worktrees_and_keeps_idle_continuations() {
    let f = fixture("handoff-cas");
    let mut outside = Client::open(&f.service, client(true)).await;
    let idle = outside
        .ok(
            "t3_thread_launch",
            json!({"projectId":project_id(),"title":"Idle"}),
        )
        .await;
    let thread = idle["threadId"].as_str().unwrap();
    let dispatch = |value| {
        f.service
            .config
            .engine
            .dispatch(conn_contract::from_json(value).unwrap())
    };
    assert!(dispatch(json!({"type":"thread.metadata.update","commandId":"stale","threadId":thread,"worktreePath":"/ignored","expectedWorktreePath":"/stale"})).await.is_err());
    dispatch(json!({"type":"thread.metadata.update","commandId":"idle-move","threadId":thread,"branch":"feature","worktreePath":"/new","expectedWorktreePath":null,"continuation":{"messageId":"resume-idle","text":"hello"}})).await.unwrap();
    let ended = outside
        .ok(
            "t3_thread_wait",
            json!({"threadId":thread,"timeoutMs":10000}),
        )
        .await;
    assert_eq!(ended["status"], "completed");
    let projection = f
        .service
        .config
        .engine
        .get_thread_projection(thread.into())
        .await
        .unwrap();
    assert_eq!(projection["runs"].as_array().unwrap().len(), 1);
    assert_eq!(projection["thread"]["worktreePath"], "/new");
}

#[tokio::test(flavor = "current_thread")]
async fn handoff_setup_runs_in_a_thread_terminal_with_the_project_environment() {
    let mut f = fixture("handoff-setup");
    let shell = f.dir.join("shell");
    conn_support::test_util::executable(
        &shell,
        "#!/bin/sh\nexport HISTFILE=/dev/null\nexec /bin/sh \"$@\"\n",
    )
    .unwrap();
    let terminals = conn_terminal::TerminalManager::new(conn_terminal::TerminalConfig {
        shells: vec![shell.to_string_lossy().into_owned()],
        ..Default::default()
    });
    Arc::get_mut(&mut f.service)
        .unwrap()
        .config
        .worktrees
        .as_mut()
        .unwrap()
        .terminals = Some(terminals.clone());
    let root = git_project(&f).await;
    f.service.config.engine.call("projects.mutate",json!({"type":"project.update","commandId":"setup-script","projectId":project_id(),"scripts":[{"id":"setup","name":"Install","icon":"play","command":"printf '%s\\n%s\\n' \"$T3CODE_PROJECT_ROOT\" \"$T3CODE_WORKTREE_PATH\" > setup-proof.txt; printf 'SETUP-%s\\n' done","runOnWorktreeCreate":true}]})).await.unwrap();
    let (parent, caller) = running_parent(&f).await;
    let thread = parent["threadId"].as_str().unwrap();
    let mut agent = Client::open(&f.service, caller).await;
    let moved = agent
        .ok(
            "t3_worktree_handoff",
            json!({"branch":"feature/setup","startFromOrigin":false}),
        )
        .await;
    assert_eq!(
        moved["setupScript"],
        json!({"status":"started","scriptName":"Install","terminalId":"setup-setup"})
    );
    let mut output = terminals
        .observe(
            conn_contract::from_json(json!({"threadId":thread,"terminalId":"setup-setup"}))
                .unwrap(),
        )
        .unwrap();
    let mut text = String::new();
    loop {
        match output.next().await {
            conn_contract::TerminalAttachStreamEvent::Output(event) => text.push_str(&event.data),
            conn_contract::TerminalAttachStreamEvent::Snapshot(event) => {
                text.push_str(&event.snapshot.history)
            }
            _ => {}
        }
        if text.contains("SETUP-done") {
            break;
        }
    }
    let path = moved["worktreePath"].as_str().unwrap();
    assert_eq!(
        std::fs::read_to_string(PathBuf::from(path).join("setup-proof.txt")).unwrap(),
        format!("{}\n{path}\n", root.display())
    );
    std::fs::remove_file(PathBuf::from(path).join("setup-proof.txt")).unwrap();
    terminals.close(
        conn_contract::from_json(json!({"threadId":thread,"terminalId":"setup-setup"})).unwrap(),
    );
    let shell = f.service.config.engine.shell_snapshot().await.unwrap();
    let project = shell["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == project_id())
        .unwrap();
    f.service
        .run_worktree_setup(thread, path, project)
        .await
        .unwrap();
    let mut output = terminals
        .observe(
            conn_contract::from_json(json!({"threadId":thread,"terminalId":"setup-setup"}))
                .unwrap(),
        )
        .unwrap();
    let mut text = String::new();
    while !text.contains("SETUP-done") {
        match output.next().await {
            conn_contract::TerminalAttachStreamEvent::Output(event) => text.push_str(&event.data),
            conn_contract::TerminalAttachStreamEvent::Snapshot(event) => {
                text.push_str(&event.snapshot.history)
            }
            _ => {}
        }
    }
    assert_eq!(
        std::fs::read_to_string(PathBuf::from(path).join("setup-proof.txt")).unwrap(),
        format!("{}\n{path}\n", root.display())
    );
    terminals.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn handoff_fetches_remote_base_and_list_falls_back_after_worktree_cleanup() {
    let f = fixture("handoff-origin");
    let root = git_project(&f).await;
    let source = root.clone();
    let remote = f.dir.join("remote.git");
    let remote_sha = tokio::task::spawn_blocking(move || {
        let sha = git(&source, &["rev-parse", "HEAD"]);
        git(
            &source,
            &[
                "clone",
                "--bare",
                source.to_str().unwrap(),
                remote.to_str().unwrap(),
            ],
        );
        git(
            &source,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(
            &source,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "local",
            ],
        );
        sha
    })
    .await
    .unwrap();
    let (parent, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    assert_eq!(
        agent
            .failure("t3_worktree_handoff", json!({"branch":"main"}))
            .await
            .0,
        "invalid_request"
    );
    let moved = agent
        .ok(
            "t3_worktree_handoff",
            json!({"branch":"feature/origin","runSetupScript":false}),
        )
        .await;
    assert_eq!(moved["startedFromOrigin"], true);
    let path = PathBuf::from(moved["worktreePath"].as_str().unwrap());
    let head = conn_vcs::process::GitCommand::new("proof", &path, ["rev-parse", "HEAD"])
        .text()
        .await
        .unwrap();
    assert_eq!(head.trim(), remote_sha);
    conn_vcs::worktree::remove_worktree(&root, &path, conn_vcs::worktree::Removal::Force)
        .await
        .unwrap();
    let mut outside = Client::open(&f.service, client(false)).await;
    let refs = outside
        .ok("t3_worktree_list", json!({"threadId":format!("  {}  ",parent["threadId"].as_str().unwrap()),"query":"  main  "}))
        .await;
    assert_eq!(refs["isRepo"], true);
    assert!(
        refs["refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["name"] == "main")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn concurrent_handoff_is_refused_and_a_raced_binding_rolls_back_git() {
    let f = fixture("handoff-race");
    let root = git_project(&f).await;
    let (parent, caller) = running_parent(&f).await;
    let (ready, release) = checkout_gate(&f, &root).await;
    let service = f.service.clone();
    let first_caller = caller.clone();
    let first = tokio::spawn(async move {
        let mut agent = Client::open(&service, first_caller).await;
        agent
            .failure(
                "t3_worktree_handoff",
                json!({"branch":"feature/race","startFromOrigin":false}),
            )
            .await
    });
    tokio::task::spawn_blocking(move || std::fs::read(ready).unwrap())
        .await
        .unwrap();
    let mut agent = Client::open(&f.service, caller).await;
    assert_eq!(
        agent
            .failure("t3_worktree_handoff", json!({"branch":"feature/second"}))
            .await
            .0,
        "handoff_in_progress"
    );
    f.service.config.engine.dispatch(conn_contract::from_json(json!({"type":"thread.metadata.update","commandId":"ui-move","threadId":parent["threadId"],"worktreePath":"/ui-moved","expectedWorktreePath":null})).unwrap()).await.unwrap();
    tokio::task::spawn_blocking(move || std::fs::write(release, b"go\n").unwrap())
        .await
        .unwrap();
    assert_eq!(first.await.unwrap().0, "already_in_worktree");
    assert!(
        !conn_vcs::repo::ref_exists(&root, "refs/heads/feature/race")
            .await
            .unwrap()
    );
    assert_eq!(
        conn_vcs::worktree::list_worktrees(&root)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test(flavor = "current_thread")]
async fn create_threads_checks_project_provider_policy_and_prefixes_dispatch_errors() {
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Policy(Arc<AtomicBool>);
    impl conn_engine::EngineHost for Policy {
        fn provider_instance_enabled(&self, _: Option<&str>, _: &str) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }
    let enabled = Arc::new(AtomicBool::new(true));
    let f = fixture_with_host("batch-policy", Some(Arc::new(Policy(enabled.clone()))));
    let (_, caller) = running_parent(&f).await;
    let mut agent = Client::open(&f.service, caller).await;
    let accepted = json!({"threads":[{"prompt":"hang"}],"clientRequestId":"accepted"});
    agent.ok("create_threads", accepted.clone()).await;
    agent
        .ok(
            "create_threads",
            json!({"threads":[{}],"clientRequestId":"idle-disabled"}),
        )
        .await;
    enabled.store(false, Ordering::SeqCst);
    for target in [json!({}), json!({"providerInstanceId":"claudeAgent"})] {
        assert_eq!(
            agent
                .failure("create_threads", json!({"threads":[{"target":target}]}))
                .await,
            (
                "invalid_request".into(),
                format!(
                    "Provider instance \"claudeAgent\" is disabled for project {}.",
                    project_id()
                )
            )
        );
    }
    agent.ok("create_threads", accepted).await;
    assert_eq!(
        agent
            .failure(
                "create_threads",
                json!({"threads":[{"prompt":"hang"}],"clientRequestId":"idle-disabled"})
            )
            .await
            .0,
        "invalid_request"
    );
    enabled.store(true, Ordering::SeqCst);
    let conflict = "thread:mcp:handoff-session:conflict:1";
    f.service.config.engine.dispatch(conn_contract::from_json(json!({"type":"thread.create","commandId":"conflict-existing","threadId":conflict,"projectId":project_id(),"title":"Existing","modelSelection":{"instanceId":"claudeAgent","model":"claude-haiku-5-5"},"runtimeMode":"auto","interactionMode":"default","branch":null,"worktreePath":null,"createdBy":"agent","creationSource":"mcp"})).unwrap()).await.unwrap();
    assert_eq!(
        agent
            .failure(
                "create_threads",
                json!({"threads":[{},{}],"clientRequestId":"conflict"})
            )
            .await,
        (
            "orchestration_error".into(),
            format!("Unable to create thread 2: Thread {conflict} already exists.")
        )
    );
}

async fn checkout_gate(f: &Fixture, root: &std::path::Path) -> (PathBuf, PathBuf) {
    let ready = f.dir.join("ready");
    let release = f.dir.join("release");
    let hook = root.join(".git/hooks/post-checkout");
    let (a, b, c) = (ready.clone(), release.clone(), hook);
    tokio::task::spawn_blocking(move || {
        assert!(
            std::process::Command::new("mkfifo")
                .args([&a, &b])
                .status()
                .unwrap()
                .success()
        );
        let quote = |p: &PathBuf| format!("'{}'", p.display().to_string().replace('\'', "'\\''"));
        conn_support::test_util::executable(
            &c,
            &format!(
                "#!/bin/sh\nprintf ready > {}\nread release < {}\n",
                quote(&a),
                quote(&b)
            ),
        )
        .unwrap();
    })
    .await
    .unwrap();
    (ready, release)
}

#[tokio::test(flavor = "current_thread")]
async fn handoff_reports_the_committed_continuation_when_the_caller_ends_during_checkout() {
    let f = fixture("handoff-delivery-race");
    let root = git_project(&f).await;
    let (parent, caller) = running_parent(&f).await;
    let (ready, release) = checkout_gate(&f, &root).await;
    let service = f.service.clone();
    let handoff = tokio::spawn(async move {
        let mut agent = Client::open(&service, caller).await;
        agent.ok("t3_worktree_handoff",json!({"branch":"feature/ended-caller","startFromOrigin":false,"continuationPrompt":"hang"})).await
    });
    tokio::task::spawn_blocking(move || std::fs::read(ready).unwrap())
        .await
        .unwrap();
    let mut outside = Client::open(&f.service, client(true)).await;
    outside
        .ok(
            "t3_thread_interrupt",
            json!({"threadId":parent["threadId"],"runId":parent["runId"]}),
        )
        .await;
    outside
        .ok(
            "t3_thread_wait",
            json!({"threadId":parent["threadId"],"runId":parent["runId"],"timeoutMs":10000}),
        )
        .await;
    tokio::task::spawn_blocking(move || std::fs::write(release, b"go\n").unwrap())
        .await
        .unwrap();
    let moved = handoff.await.unwrap();
    assert_eq!(
        moved["continuation"],
        json!({"status":"scheduled","delivery":"started"})
    );
}
