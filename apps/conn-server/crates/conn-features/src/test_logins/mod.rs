//! Test users in the settings secret store, compatible with T3's `test-logins` file.

use conn_contract::{
    SaveTestLoginInput, TestLoginList, TestLoginSecrets, TestLoginSummary,
    TestLoginSummaryCreatedBy, UpdateTestLoginInput,
};
use conn_support::secret_store;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub mod origin;
#[cfg(test)]
mod tests;
pub mod totp;

/// T3 has no count cap; bound each read and rewrite without keeping a cache.
const MAX_LOGINS: usize = 1024;
/// Bounds the secret-store file read, including files written by T3.
const MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum TestLoginError {
    #[error("Conn could not read or save its test logins.")]
    Store,
    #[error("No test login with this id.")]
    NotFound(String),
}
impl TestLoginError {
    pub fn to_contract(&self) -> Value {
        match self {
            Self::Store => json!({"_tag":"TestLoginStoreError"}),
            Self::NotFound(id) => json!({"_tag":"TestLoginNotFoundError","id":id}),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLogin {
    id: String,
    label: String,
    url: String,
    username: String,
    password: String,
    #[serde(deserialize_with = "Option::deserialize")]
    otp_secret: Option<String>,
    created_at: String,
    created_by: TestLoginSummaryCreatedBy,
}
impl StoredLogin {
    fn summary(&self) -> TestLoginSummary {
        TestLoginSummary {
            id: self.id.clone(),
            label: self.label.clone(),
            url: self.url.clone(),
            username: self.username.clone(),
            has_otp: self.otp_secret.is_some(),
            created_at: self.created_at.clone(),
            created_by: self.created_by,
        }
    }
}
#[derive(Serialize, Deserialize)]
struct Stored {
    version: u8,
    logins: Vec<StoredLogin>,
}

#[derive(Clone, Debug)]
pub struct TestLogins {
    dir: PathBuf,
    lock: Arc<Mutex<()>>,
}
impl TestLogins {
    pub fn new(state_dir: &Path) -> Self {
        Self {
            dir: state_dir.join("secrets"),
            lock: Arc::new(Mutex::new(())),
        }
    }
    async fn disk<T: Send + 'static>(
        &self,
        change: impl FnOnce(&Path, Vec<StoredLogin>) -> Result<T, TestLoginError> + Send + 'static,
    ) -> Result<T, TestLoginError> {
        let dir = self.dir.clone();
        let lock = self.lock.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = lock.lock().map_err(|_| TestLoginError::Store)?;
            change(&dir, read(&dir)?)
        })
        .await
        .map_err(|_| TestLoginError::Store)?
    }
    pub async fn list(&self) -> Result<TestLoginList, TestLoginError> {
        self.disk(|_, logins| {
            Ok(TestLoginList {
                items: logins.iter().map(StoredLogin::summary).collect(),
            })
        })
        .await
    }
    pub async fn save(
        &self,
        input: SaveTestLoginInput,
        created_by: TestLoginSummaryCreatedBy,
    ) -> Result<TestLoginSummary, TestLoginError> {
        self.disk(move |dir, mut logins| {
            if logins.len() >= MAX_LOGINS {
                return Err(TestLoginError::Store);
            }
            let login = StoredLogin {
                id: conn_support::uuid_v4(),
                label: conn_support::text::js_trim(&input.label.unwrap_or_default()).to_owned(),
                url: conn_support::text::js_trim(&input.url).to_owned(),
                username: input.username,
                password: input.password,
                otp_secret: nonempty(input.otp_secret),
                created_at: conn_support::time::iso_from_ms(conn_support::time::now_ms()),
                created_by,
            };
            let summary = login.summary();
            logins.push(login);
            write(dir, logins)?;
            Ok(summary)
        })
        .await
    }
    pub async fn update(
        &self,
        input: UpdateTestLoginInput,
    ) -> Result<TestLoginSummary, TestLoginError> {
        self.disk(move |dir, mut logins| {
            let login = logins
                .iter_mut()
                .find(|l| l.id == input.id)
                .ok_or(TestLoginError::NotFound(input.id))?;
            if let Some(value) = input.label {
                login.label = conn_support::text::js_trim(&value).to_owned();
            }
            if let Some(value) = input.url {
                login.url = conn_support::text::js_trim(&value).to_owned();
            }
            if let Some(value) = input.username {
                login.username = value;
            }
            if let Some(value) = input.password {
                login.password = value;
            }
            if let Some(value) = input.otp_secret {
                login.otp_secret = nonempty(value);
            }
            let summary = login.summary();
            write(dir, logins)?;
            Ok(summary)
        })
        .await
    }
    pub async fn remove(&self, id: &str) -> Result<(), TestLoginError> {
        let id = id.to_owned();
        self.disk(move |dir, mut logins| {
            if !logins.iter().any(|l| l.id == id) {
                return Err(TestLoginError::NotFound(id));
            }
            logins.retain(|l| l.id != id);
            write(dir, logins)
        })
        .await
    }
    pub async fn reveal(&self, id: &str) -> Result<TestLoginSecrets, TestLoginError> {
        let id = id.to_owned();
        self.disk(move |_, logins| {
            let login = logins
                .into_iter()
                .find(|l| l.id == id)
                .ok_or(TestLoginError::NotFound(id))?;
            Ok(TestLoginSecrets {
                password: login.password,
                otp_secret: login.otp_secret,
            })
        })
        .await
    }
}
fn nonempty(value: Option<String>) -> Option<String> {
    value
        .map(|s| conn_support::text::js_trim(&s).to_owned())
        .filter(|s| !s.is_empty())
}
fn read(dir: &Path) -> Result<Vec<StoredLogin>, TestLoginError> {
    use std::io::Read;
    let file = match std::fs::File::open(dir.join("test-logins.bin")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(TestLoginError::Store),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| TestLoginError::Store)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(TestLoginError::Store);
    }
    let stored: Stored = serde_json::from_slice(&bytes).map_err(|_| TestLoginError::Store)?;
    if stored.version != 1 || stored.logins.len() > MAX_LOGINS {
        return Err(TestLoginError::Store);
    }
    Ok(stored.logins)
}
fn write(dir: &Path, logins: Vec<StoredLogin>) -> Result<(), TestLoginError> {
    let bytes =
        serde_json::to_vec(&Stored { version: 1, logins }).map_err(|_| TestLoginError::Store)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(TestLoginError::Store);
    }
    secret_store::write(dir, "test-logins", &bytes).map_err(|_| TestLoginError::Store)
}
