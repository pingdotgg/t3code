use super::*;
use conn_contract::from_json;

fn store() -> (PathBuf, TestLogins) {
    let dir = std::env::temp_dir().join(format!("conn-test-logins-{}", conn_support::uuid_v4()));
    let store = TestLogins::new(&dir);
    (dir, store)
}
fn input() -> SaveTestLoginInput {
    from_json(json!({"url":" https://example.test/login ","username":" admin ","password":" exact password ","label":" Admin ","otpSecret":" OTP "})).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn save_update_reveal_remove_keep_order_and_exact_secrets_across_restarts() {
    let (dir, store) = store();
    assert!(store.list().await.unwrap().items.is_empty());
    let first = store
        .save(input(), TestLoginSummaryCreatedBy::User)
        .await
        .unwrap();
    let second = store
        .save(input(), TestLoginSummaryCreatedBy::Agent)
        .await
        .unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(first.label, "Admin");
    assert_eq!(first.url, "https://example.test/login");
    assert_eq!(first.username, " admin ");
    assert!(first.has_otp);
    let reopened = TestLogins::new(&dir);
    assert_eq!(
        reopened.list().await.unwrap().items,
        vec![first.clone(), second.clone()]
    );
    let secrets = reopened.reveal(&first.id).await.unwrap();
    assert_eq!(secrets.password, " exact password ");
    assert_eq!(secrets.otp_secret.as_deref(), Some("OTP"));
    let next=store.update(from_json(json!({"id":first.id,"label":" New ","url":" localhost ","password":"","otpSecret":null})).unwrap()).await.unwrap();
    assert_eq!(next.created_at, first.created_at);
    assert_eq!(next.created_by, first.created_by);
    assert_eq!(next.label, "New");
    assert_eq!(next.url, "localhost");
    assert_eq!(next.username, first.username);
    assert!(!next.has_otp);
    assert_eq!(reopened.reveal(&first.id).await.unwrap().password, "");
    let listed = store.list().await.unwrap();
    assert_eq!(listed.items, vec![next, second.clone()]);
    assert!(!serde_json::to_string(&listed).unwrap().contains("password"));
    store.remove(&first.id).await.unwrap();
    for error in [
        store.remove(&first.id).await.unwrap_err(),
        store.reveal(&first.id).await.unwrap_err(),
        store
            .update(from_json(json!({"id":first.id})).unwrap())
            .await
            .unwrap_err(),
    ] {
        assert_eq!(
            error.to_contract(),
            json!({"_tag":"TestLoginNotFoundError","id":first.id})
        );
    }
    assert_eq!(store.list().await.unwrap().items, vec![second]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn concurrent_saves_preserve_both_entries_and_use_the_settings_secret_store() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, store) = store();
    let (a, b) = tokio::join!(
        store.save(input(), TestLoginSummaryCreatedBy::User),
        store.save(input(), TestLoginSummaryCreatedBy::Agent)
    );
    let ids: Vec<_> = store
        .list()
        .await
        .unwrap()
        .items
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert!(ids.contains(&a.unwrap().id));
    assert!(ids.contains(&b.unwrap().id));
    let bytes = secret_store::read(&dir.join("secrets"), "test-logins")
        .unwrap()
        .unwrap();
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(data["version"], 1);
    assert_eq!(data["logins"].as_array().unwrap().len(), 2);
    assert_eq!(
        std::fs::metadata(dir.join("secrets/test-logins.bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(dir.join("secrets"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn reads_t3_records_and_refuses_corruption_without_overwriting_it() {
    let (dir, store) = store();
    let record = json!({"version":1,"logins":[{"id":"legacy","label":"","url":"localhost","username":"u","password":"p","otpSecret":null,"createdAt":"2026-11-16T00:00:00.000Z","createdBy":"user"}]});
    secret_store::write(
        &dir.join("secrets"),
        "test-logins",
        record.to_string().as_bytes(),
    )
    .unwrap();
    assert_eq!(store.list().await.unwrap().items[0].id, "legacy");
    for bytes in [
        b"broken".as_slice(),
        b"{\"version\":2,\"logins\":[]}",
        b"{\"version\":1,\"logins\":[{}]}",
        br#"{"version":1,"logins":[{"id":"legacy","label":"","url":"localhost","username":"u","password":"p","createdAt":"2026-11-16T00:00:00.000Z","createdBy":"user"}]}"#,
    ] {
        secret_store::write(&dir.join("secrets"), "test-logins", bytes).unwrap();
        assert_eq!(
            store.list().await.unwrap_err().to_contract(),
            json!({"_tag":"TestLoginStoreError"})
        );
        assert!(
            store
                .save(input(), TestLoginSummaryCreatedBy::Agent)
                .await
                .is_err()
        );
        assert_eq!(
            secret_store::read(&dir.join("secrets"), "test-logins")
                .unwrap()
                .unwrap(),
            bytes
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn refuses_full_or_oversized_stores_without_changing_them() {
    let (dir, store) = store();
    let login = json!({"id":"legacy","label":"","url":"localhost","username":"u","password":"p","otpSecret":null,"createdAt":"2026-11-16T00:00:00.000Z","createdBy":"user"});
    let full = json!({"version":1,"logins":vec![login;MAX_LOGINS]}).to_string();
    secret_store::write(&dir.join("secrets"), "test-logins", full.as_bytes()).unwrap();
    assert_eq!(store.list().await.unwrap().items.len(), MAX_LOGINS);
    assert!(
        store
            .save(input(), TestLoginSummaryCreatedBy::Agent)
            .await
            .is_err()
    );
    assert_eq!(
        secret_store::read(&dir.join("secrets"), "test-logins")
            .unwrap()
            .unwrap(),
        full.as_bytes()
    );
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(dir.join("secrets/test-logins.bin"))
        .unwrap();
    file.set_len(MAX_BYTES + 1).unwrap();
    assert!(store.list().await.is_err());
    assert!(
        store
            .save(input(), TestLoginSummaryCreatedBy::Agent)
            .await
            .is_err()
    );
    assert_eq!(file.metadata().unwrap().len(), MAX_BYTES + 1);
    drop(file);
    std::fs::remove_dir_all(dir).unwrap();
}
