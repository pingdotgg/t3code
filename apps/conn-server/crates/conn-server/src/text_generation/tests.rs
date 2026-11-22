//! The cases of `TextGenerators.test.ts`, against a stub API on loopback. No outside call.

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use super::*;

#[derive(Clone, Debug, Default)]
pub(crate) struct Recorded {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: String,
}

impl Recorded {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

type Answer = Arc<dyn Fn(&Recorded) -> (u16, String) + Send + Sync>;

/// A loopback HTTP/1.1 server that records each request and answers from `answer`.
pub(crate) struct Stub {
    pub(crate) base: String,
    pub(crate) requests: Arc<Mutex<Vec<Recorded>>>,
    answer: Arc<Mutex<Answer>>,
}

impl Stub {
    pub(crate) async fn start(
        answer: impl Fn(&Recorded) -> (u16, String) + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let answer: Arc<Mutex<Answer>> = Arc::new(Mutex::new(Arc::new(answer)));
        let (log, script) = (requests.clone(), answer.clone());
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (log, script) = (log.clone(), script.clone());
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let (head_end, length) = loop {
                        let n = socket.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                            let length = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            break (end + 4, length);
                        }
                    };
                    while buf.len() < head_end + length {
                        let n = socket.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                    let mut lines = head.split("\r\n");
                    let mut first = lines.next().unwrap_or_default().split(' ');
                    let recorded = Recorded {
                        method: first.next().unwrap_or_default().to_owned(),
                        path: first.next().unwrap_or_default().to_owned(),
                        headers: lines
                            .filter_map(|l| l.split_once(':'))
                            .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_owned()))
                            .collect(),
                        body: String::from_utf8_lossy(&buf[head_end..]).into_owned(),
                    };
                    let answer = script.lock().unwrap().clone();
                    let (status, text) = answer(&recorded);
                    log.lock().unwrap().push(recorded);
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                        text.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
        Self {
            base,
            requests,
            answer,
        }
    }

    pub(crate) fn answer(
        &self,
        answer: impl Fn(&Recorded) -> (u16, String) + Send + Sync + 'static,
    ) {
        *self.answer.lock().unwrap() = Arc::new(answer);
    }

    pub(crate) fn taken(&self) -> Vec<Recorded> {
        std::mem::take(&mut *self.requests.lock().unwrap())
    }
}

pub(crate) struct Fixture {
    pub(crate) generators: TextGenerators,
    pub(crate) settings: Arc<Mutex<Map<String, Value>>>,
    _dir: TempDir,
}

pub(crate) struct TempDir(pub(crate) std::path::PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn temp_dir(name: &str) -> TempDir {
    let dir = std::env::temp_dir().join(format!(
        "conn-textgen-{name}-{}-{}",
        std::process::id(),
        conn_support::time::now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

pub(crate) fn fixture(name: &str, settings: Value) -> Fixture {
    let dir = temp_dir(name);
    let Value::Object(map) = settings else {
        panic!("settings must be an object")
    };
    let settings = Arc::new(Mutex::new(map));
    let read = settings.clone();
    Fixture {
        generators: TextGenerators::new(move || read.lock().unwrap().clone()),
        settings,
        _dir: dir,
    }
}

const ID: &str = "router";

fn generator(base: &str, extra: Value) -> Value {
    let mut config = json!({"kind": "openaiCompatible", "baseUrl": format!("{base}/v1")});
    if let (Some(config), Value::Object(extra)) = (config.as_object_mut(), extra) {
        config.extend(extra);
    }
    json!({ "textGenerators": { ID: config } })
}

fn input(value: Value) -> ListTextGeneratorModelsInput {
    conn_contract::from_json(value).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn each_api_generates_with_its_request_shape() {
    for (kind, path, auth, reply) in [
        (
            "openaiCompatible",
            "/v1/chat/completions",
            ("authorization", "Bearer secret"),
            json!({"choices": [{"finish_reason": "stop", "message": {"content": "{\"title\":\"Fix login\"}"}}]}),
        ),
        (
            "anthropic",
            "/v1/messages",
            ("x-api-key", "secret"),
            json!({"stop_reason": "end_turn", "content": [{"type": "text", "text": "{\"title\":\"Fix login\"}"}]}),
        ),
    ] {
        let reply = reply.to_string();
        let stub = Stub::start(move |_| (200, reply.clone())).await;
        let f = fixture(
            "shape",
            generator(&stub.base, json!({"kind": kind, "apiKey": "secret"})),
        );
        let text = f
            .generators
            .run(ID, "some/model", "Name this thread.")
            .await
            .expect("a generator")
            .expect("text");
        assert_eq!(text, "{\"title\":\"Fix login\"}");
        let sent = stub.taken();
        let request = sent.first().unwrap();
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("POST", path)
        );
        assert_eq!(request.header(auth.0), Some(auth.1));
        assert_eq!(request.header("content-type"), Some("application/json"));
        let body: Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(body["model"], "some/model");
        assert_eq!(
            body["messages"],
            json!([{"role": "user", "content": "Name this thread."}])
        );
        assert!(
            f.generators.run("codex", "m", "p").await.is_none(),
            "no generator"
        );

        stub.answer(|_| {
            (
                401,
                json!({"error": {"message": "Incorrect API key provided"}}).to_string(),
            )
        });
        let failure = f
            .generators
            .run(ID, "some/model", "x")
            .await
            .unwrap()
            .unwrap_err();
        assert!(
            failure.ends_with("rejected the API key: Incorrect API key provided"),
            "{failure}"
        );
        assert!(!failure.contains("secret"));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_turned_off_generator_fails_without_a_call() {
    let stub = Stub::start(|_| (200, "{}".into())).await;
    let f = fixture(
        "off",
        generator(&stub.base, json!({"enabled": false, "label": "OpenRouter"})),
    );
    let failure = f.generators.run(ID, "m", "p").await.unwrap().unwrap_err();
    assert_eq!(
        failure,
        "OpenRouter is off. Turn it on in Settings \u{2192} Providers."
    );
    assert!(stub.taken().is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn lists_once_per_config_following_anthropic_pages_until_refreshed() {
    let stub = Stub::start(|request| {
        assert!(request.path.starts_with("/v1/models?limit=1000"), "{}", request.path);
        let body = if request.path.contains("after_id=claude-b") {
            json!({"data": [{"id": "claude-a"}], "has_more": false})
        } else {
            json!({"data": [{"id": "claude-b", "display_name": "Claude B"}], "has_more": true, "last_id": "claude-b"})
        };
        (200, body.to_string())
    })
    .await;
    let f = fixture(
        "pages",
        generator(&stub.base, json!({"kind": "anthropic", "apiKey": "secret"})),
    );
    let list = |refresh: bool| {
        let value = if refresh {
            json!({"id": ID, "refresh": true})
        } else {
            json!({"id": ID})
        };
        f.generators.list_models(input(value))
    };
    let models = list(false).await.unwrap().models;
    assert_eq!(
        conn_contract::to_json(&models),
        json!([{"id": "claude-a", "name": "claude-a"}, {"id": "claude-b", "name": "Claude B"}])
    );
    list(false).await.unwrap();
    assert_eq!(stub.taken().len(), 2, "the second list is cached");
    list(true).await.unwrap();
    assert_eq!(stub.taken().len(), 2, "a refresh asks again");
    // A changed key is another config: the cache does not serve it.
    f.settings.lock().unwrap()["textGenerators"][ID]["apiKey"] = json!("rotated");
    list(false).await.unwrap();
    let sent = stub.taken();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0].header("x-api-key"), Some("rotated"));
    assert_eq!(sent[0].header("anthropic-version"), Some("2023-06-01"));
}

#[tokio::test(flavor = "current_thread")]
async fn checks_unsaved_settings_keeping_the_saved_key_behind_the_marker() {
    let stub = Stub::start(|request| {
        let body = if request.path.ends_with("/chat/completions") {
            json!({"choices": [{"finish_reason": "stop", "message": {"content": "OK"}}]})
        } else {
            json!({"data": [{"id": "model-a"}]})
        };
        (200, body.to_string())
    })
    .await;
    let f = fixture(
        "unsaved",
        generator(&stub.base, json!({"apiKey": "saved-key"})),
    );
    let unsaved = |id: &str, key: &str| {
        input(json!({"id": id, "config": {
            "kind": "openaiCompatible", "baseUrl": format!("{}/new/v1", stub.base),
            "apiKey": key, "enabled": true,
        }}))
    };
    let models = f
        .generators
        .list_models(unsaved("draft", "typed-key"))
        .await
        .unwrap();
    assert_eq!(
        conn_contract::to_json(&models.models),
        json!([{"id": "model-a", "name": "model-a"}])
    );
    f.generators
        .list_models(unsaved(ID, crate::settings::SECRET_REDACTED))
        .await
        .unwrap();
    let sent = stub.taken();
    let seen: Vec<_> = sent
        .iter()
        .map(|r| (r.path.as_str(), r.header("authorization")))
        .collect();
    assert_eq!(
        seen,
        [
            ("/new/v1/models", Some("Bearer typed-key")),
            ("/new/v1/models", Some("Bearer saved-key")),
        ]
    );
    // Listing alone proves nothing about the key on some APIs; a test asks the model itself.
    let tested = f
        .generators
        .list_models(input(
            json!({"id": ID, "test": true, "model": "chosen/model"}),
        ))
        .await
        .unwrap();
    assert_eq!(tested.tested_model.as_deref(), Some("chosen/model"));
    let sent = stub.taken();
    let last = sent.last().unwrap();
    assert_eq!(last.path, "/v1/chat/completions");
    assert_eq!(last.header("authorization"), Some("Bearer saved-key"));
    assert_eq!(
        serde_json::from_str::<Value>(&last.body).unwrap()["messages"][0]["content"],
        "Reply with OK."
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_missing_generator_and_an_unreadable_reference_fail_in_words() {
    let f = fixture("missing", json!({}));
    let error = f
        .generators
        .list_models(input(json!({"id": "gone"})))
        .await
        .unwrap_err();
    assert_eq!(error, "That text generator no longer exists.");
    let f = fixture(
        "reference",
        json!({
            "textGenerators": { ID: {"kind": "openaiCompatible", "baseUrl": "http://127.0.0.1:9/v1",
                "apiKey": {"provider": "op", "reference": "op://vault/item/key"}} },
            "secretProviders": { "op": {"kind": "onepassword", "label": " 1Password "} },
        }),
    );
    let error = f
        .generators
        .list_models(input(json!({"id": ID})))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        "Could not read the credential from the secret provider \"1Password\". Unlock or fix it in Settings, then try again."
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_marker_reads_the_key_from_the_t3_secret_store() {
    let stub = Stub::start(|_| (200, json!({"data": []}).to_string())).await;
    let dir = temp_dir("store");
    let Value::Object(settings) = generator(
        &stub.base,
        json!({"apiKey": crate::settings::SECRET_REDACTED}),
    ) else {
        panic!("settings must be an object")
    };
    std::fs::write(
        dir.0.join("settings.json"),
        Value::Object(settings).to_string(),
    )
    .unwrap();
    // `text-generator-${base64url(id)}-${base64url("apiKey")}.bin`
    conn_support::secret_store::write(
        &dir.0.join("secrets"),
        "text-generator-cm91dGVy-YXBpS2V5",
        b"stored-key",
    )
    .unwrap();
    let store = crate::settings::SettingsStore::open(dir.0.join("settings.json"));
    let generators = TextGenerators::new(move || store.raw());
    generators
        .list_models(input(json!({"id": ID})))
        .await
        .unwrap();
    assert_eq!(
        stub.taken()[0].header("authorization"),
        Some("Bearer stored-key")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn replies_the_t3_server_cannot_read_fail_as_it_does() {
    let stub = Stub::start(|_| (200, "not json".into())).await;
    let f = fixture(
        "unreadable",
        generator(&stub.base, json!({"label": "Router"})),
    );
    assert_eq!(
        run_err(&f).await,
        "Router returned a reply Conn couldn't read."
    );
    stub.answer(|_| {
        (
            200,
            json!({"choices": [{"finish_reason": "length", "message": {"content": "x"}}]})
                .to_string(),
        )
    });
    assert_eq!(run_err(&f).await, "Router reached its output limit.");
    stub.answer(|_| {
        (
            200,
            json!({"choices": [{"finish_reason": null, "message": {"content": "  "}}]}).to_string(),
        )
    });
    assert_eq!(run_err(&f).await, "Router returned no text.");
    stub.answer(|_| {
        (
            200,
            json!({"choices": [{"message": {"content": "x"}}]}).to_string(),
        )
    });
    assert_eq!(
        run_err(&f).await,
        "Router returned a reply Conn couldn't read."
    );
    let f = fixture("unreachable", generator("http://127.0.0.1:9", json!({})));
    assert_eq!(
        run_err(&f).await,
        "Couldn't reach 127.0.0.1:9. Check the base URL and your connection."
    );
}

async fn run_err(f: &Fixture) -> String {
    f.generators.run(ID, "m", "p").await.unwrap().unwrap_err()
}

#[test]
fn labels_and_base_urls_follow_the_contract() {
    assert_eq!(
        generator_label(&json!({"baseUrl": "https://API.test:443/v1"})),
        "api.test"
    );
    assert_eq!(
        generator_label(&json!({"baseUrl": "http://h:8080/v1"})),
        "h:8080"
    );
    assert_eq!(
        generator_label(&json!({"baseUrl": "nope"})),
        "The model API"
    );
    assert_eq!(
        generator_label(&json!({"label": "Mine", "baseUrl": "nope"})),
        "Mine"
    );
    assert!(valid_base_url("https://api.test/v1"));
    assert!(!valid_base_url("https://u:p@api.test/v1"));
    assert!(!valid_base_url("https://api.test/v1?x=1"));
    assert!(!valid_base_url("ftp://api.test"));
}

#[test]
fn the_debug_output_never_holds_a_key() {
    let connection = Connection {
        kind: Kind::OpenAiCompatible,
        base_url: "https://api.test".into(),
        api_key: Secret::new("sk-very-secret"),
        label: "x".into(),
    };
    assert!(!format!("{connection:?}").contains("sk-very-secret"));
    let f = fixture(
        "debug",
        json!({"textGenerators": {"a": {"apiKey": "sk-very-secret"}}}),
    );
    assert!(!format!("{:?}", f.generators).contains("sk-very-secret"));
}

pub(crate) mod titles {
    use std::time::Duration;

    use super::*;
    use crate::text_generation::title::{AGENT_TITLES_NOT_SERVED, Titles, title_selection};
    use conn_engine::{TitleKind, TitleMessage, TitleRequest};

    fn initial(text: &str) -> TitleRequest {
        TitleRequest {
            thread_id: "t".into(),
            project_id: Some("p1".into()),
            cwd: None,
            project_title: Some("Conn".into()),
            kind: TitleKind::Initial {
                message: TitleMessage {
                    role: "user".into(),
                    text: text.into(),
                    attachments: vec![],
                },
            },
        }
    }

    fn settings_for(base: &str, selection: Value) -> Value {
        let mut settings = generator(base, json!({"apiKey": "tk"}));
        settings["textGenerationModelSelection"] = selection;
        settings
    }

    /// An agent provider for titles: answers `generate_text` with `answer`, or does not
    /// generate text at all (`None`), and keeps the requests it got.
    pub(crate) struct AgentProvider {
        id: conn_contract::ProviderInstanceId,
        driver: &'static str,
        answer: Option<Value>,
        requests: std::sync::Mutex<Vec<conn_provider::TextGenerationRequest>>,
    }

    impl AgentProvider {
        pub(crate) fn new(id: &str, driver: &'static str, answer: Option<Value>) -> Arc<Self> {
            Arc::new(Self {
                id: id.into(),
                driver,
                answer,
                requests: std::sync::Mutex::default(),
            })
        }
    }

    impl conn_provider::Provider for AgentProvider {
        fn instance_id(&self) -> &conn_contract::ProviderInstanceId {
            &self.id
        }
        fn driver(&self) -> &str {
            self.driver
        }
        fn capabilities(
            &self,
        ) -> conn_provider::BoxFuture<
            '_,
            conn_provider::ProviderResult<conn_contract::ProviderCapabilities>,
        > {
            Box::pin(async { Err(conn_provider::ProviderError::SessionStopped) })
        }
        fn open_session(
            &self,
            _input: conn_provider::OpenSessionInput,
        ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<conn_provider::OpenedSession>>
        {
            Box::pin(async { Err(conn_provider::ProviderError::SessionStopped) })
        }
        fn generate_text(
            &self,
            request: conn_provider::TextGenerationRequest,
        ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<Value>> {
            if let Ok(mut requests) = self.requests.lock() {
                requests.push(request);
            }
            let answer = self.answer.clone();
            Box::pin(async move {
                answer.ok_or(conn_provider::ProviderError::Unsupported {
                    operation: "generate_text",
                })
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_agent_title_model_without_text_generation_is_refused_without_a_call() {
        let stub = Stub::start(|_| (200, "{}".into())).await;
        // The default selection is Codex; a saved Claude selection is the same.
        for settings in [
            generator(&stub.base, json!({})),
            settings_for(
                &stub.base,
                json!({"instanceId": "claudeAgent", "model": "claude-haiku"}),
            ),
        ] {
            let f = fixture("agent", settings);
            let providers: Vec<Arc<dyn conn_provider::Provider>> = vec![
                AgentProvider::new("codex", "codex", None),
                AgentProvider::new("claudeAgent", "claudeAgent", None),
            ];
            let titles = Titles::new(Arc::new(f.generators)).with_providers(providers, None);
            let error = titles.title(initial("hello")).await.unwrap_err();
            assert_eq!(error, AGENT_TITLES_NOT_SERVED);
        }
        assert!(stub.taken().is_empty(), "no request");
    }

    /// The default title model is Codex: the prompt goes to the Codex instance with T3's
    /// schema text and the whole selection, and its answer is the title.
    #[tokio::test(flavor = "current_thread")]
    async fn an_agent_title_model_asks_its_provider() {
        let stub = Stub::start(|_| (200, "{}".into())).await;
        let f = fixture(
            "agent-codex",
            settings_for(
                &stub.base,
                json!({"instanceId": "codex", "model": "gpt-6-luna",
                    "options": [{"id": "reasoningEffort", "value": "high"}]}),
            ),
        );
        let codex = AgentProvider::new(
            "codex",
            "codex",
            Some(json!({"title": " Login Redirect Fix ", "needsRefinement": false})),
        );
        let titles = Titles::new(Arc::new(f.generators)).with_providers(
            vec![codex.clone() as Arc<dyn conn_provider::Provider>],
            None,
        );
        assert_eq!(
            titles.title(initial("the login fails")).await.unwrap(),
            "Login Redirect Fix"
        );
        let request = codex.requests.lock().unwrap().remove(0);
        assert_eq!(request.operation, "generateThreadTitle");
        assert_eq!(request.output_schema, prompts::TITLE_OUTPUT_SCHEMA);
        assert!(request.prompt.ends_with("User message:\nthe login fails"));
        assert_eq!(
            conn_contract::to_json(&request.model_selection),
            json!({"instanceId": "codex", "model": "gpt-6-luna",
                "options": [{"id": "reasoningEffort", "value": "high"}]})
        );
        assert!(stub.taken().is_empty(), "no text generator call");

        // An answer without a title is "invalid structured output", named by the driver.
        let f = fixture(
            "agent-codex-bad",
            settings_for(&stub.base, json!({"instanceId": "codex", "model": "m"})),
        );
        let bad = AgentProvider::new("codex", "codex", Some(json!({"name": "x"})));
        let titles = Titles::new(Arc::new(f.generators))
            .with_providers(vec![bad as Arc<dyn conn_provider::Provider>], None)
            .with_retry_delays(&[]);
        assert_eq!(
            titles.title(initial("x")).await.unwrap_err(),
            "Codex returned invalid structured output."
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_generator_titles_the_first_message() {
        let stub = Stub::start(|_| {
            let content = "{\"title\":\" \\\"Fix Login\\\" \",\"needsRefinement\":false}";
            (
                200,
                json!({"choices": [{"finish_reason": "stop", "message": {"content": content}}]})
                    .to_string(),
            )
        })
        .await;
        let f = fixture(
            "first",
            settings_for(&stub.base, json!({"instanceId": ID, "model": "small"})),
        );
        let titles = Titles::new(Arc::new(f.generators));
        assert_eq!(
            titles.title(initial("the login fails")).await.unwrap(),
            "Fix Login"
        );
        let sent = stub.taken();
        let body: Value = serde_json::from_str(&sent[0].body).unwrap();
        assert_eq!(body["model"], "small");
        let prompt = body["messages"][0]["content"].as_str().unwrap();
        assert!(
            prompt.contains("Never include the project name (\"Conn\")"),
            "{prompt}"
        );
        assert!(
            prompt.ends_with("User message:\nthe login fails"),
            "{prompt}"
        );
    }

    /// T3 waits 2 s, then 4 s (`Schedule.exponential("2 seconds")`); the test waits 1 ms on
    /// the real clock, because a paused clock moves on while loopback I/O is pending.
    #[tokio::test(flavor = "current_thread")]
    async fn a_first_title_tries_three_times_and_a_regenerate_once() {
        let stub = Stub::start(|_| (500, "{}".into())).await;
        let f = fixture(
            "retry",
            settings_for(&stub.base, json!({"instanceId": ID, "model": "m"})),
        );
        let titles = Titles::new(Arc::new(f.generators))
            .with_retry_delays(&[Duration::from_millis(1), Duration::from_millis(1)]);
        let error = titles.title(initial("x")).await.unwrap_err();
        assert_eq!(
            error,
            format!(
                "{} returned HTTP 500.",
                stub.base.trim_start_matches("http://")
            )
        );
        assert_eq!(stub.taken().len(), 3, "two retries");
        let regenerate = TitleRequest {
            kind: TitleKind::Regenerate {
                previous_title: "Old".into(),
                messages: vec![TitleMessage {
                    role: "user".into(),
                    text: "x".into(),
                    attachments: vec![],
                }],
            },
            ..initial("x")
        };
        titles.title(regenerate).await.unwrap_err();
        assert_eq!(stub.taken().len(), 1, "no retry");
        // Only white space is still a message: the T3 server sends it too.
        assert!(titles.title(initial("   ")).await.is_err());
        assert_eq!(stub.taken().len(), 3);
        let empty = titles.title(initial("")).await.unwrap_err();
        assert_eq!(empty, "This thread has no messages to title yet.");
        assert!(stub.taken().is_empty(), "nothing to title, nothing sent");
    }

    #[test]
    fn a_project_override_wins_while_its_model_is_on() {
        let mut settings = json!({
            "textGenerationModelSelection": {"instanceId": "codex", "model": "gpt"},
            "textGenerators": {"tg": {"kind": "anthropic", "baseUrl": "https://x.test", "enabled": true}},
            "projectSettingsOverrides": {"p1": {"textGenerationModelSelection": {"instanceId": "tg", "model": "haiku"}}},
        });
        let map = |v: &Value| v.as_object().cloned().unwrap();
        assert_eq!(
            title_selection(&map(&settings), Some("p1")),
            ("tg".into(), "haiku".into())
        );
        assert_eq!(
            title_selection(&map(&settings), Some("p2")),
            ("codex".into(), "gpt".into())
        );
        settings["textGenerators"]["tg"]["enabled"] = json!(false);
        assert_eq!(
            title_selection(&map(&settings), Some("p1")),
            ("codex".into(), "gpt".into())
        );
    }
}

/// A deliberate difference from the T3 server: a link-local base URL (a cloud host's metadata
/// service) is refused without a connection; loopback, as every case here shows, stays open.
#[tokio::test(flavor = "current_thread")]
async fn a_link_local_base_url_is_refused_without_a_call() {
    for base in ["http://169.254.169.254", "http://[fe80::1]:11434"] {
        let f = fixture("link-local", generator(base, json!({"apiKey": "k"})));
        let started = std::time::Instant::now();
        let error = f
            .generators
            .list_models(input(json!({"id": ID})))
            .await
            .unwrap_err();
        assert!(error.starts_with("Couldn't reach "), "{error}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "{base}"
        );
    }
}
