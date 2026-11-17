//! Client catalogs survive restarts; connected clients contribute a bounded union.
use super::{Preview, State, lock};
use crate::{Error, spec::spec};
use serde_json::{Value, json};

impl Preview {
    pub(super) async fn load_profiles(&self) {
        self.0
            .profiles_loaded
            .get_or_init(|| async {
                let path = self
                    .0
                    .directory
                    .join("server-browser/reported-profiles.json");
                let bytes = match tokio::fs::File::open(path).await {
                    Ok(file) => {
                        use tokio::io::AsyncReadExt;
                        let mut bytes = Vec::new();
                        if file.take(512 * 1024).read_to_end(&mut bytes).await.is_err() {
                            return;
                        }
                        bytes
                    }
                    Err(_) => return,
                };
                let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                    return;
                };
                let Some(profiles) = value
                    .get("profiles")
                    .and_then(Value::as_array)
                    .filter(|p| p.len() <= 256)
                else {
                    return;
                };
                if profiles.iter().any(|p| !valid(p)) {
                    return;
                }
                let Some(default) = value.get("defaultProfileId").and_then(Value::as_str) else {
                    return;
                };
                let mut state = lock(&self.0.state);
                set_catalog(&mut state, profiles.clone(), default);
            })
            .await;
    }
    pub async fn report_profiles(
        &self,
        client: u64,
        profiles: Vec<Value>,
        default: String,
        rate: Option<u64>,
    ) -> Result<(), Error> {
        self.load_profiles().await;
        if profiles.iter().any(|p| !valid(p)) {
            return Err(Error("Invalid browser profiles.".into()));
        }
        let _save = self.0.profiles_save.lock().await;
        let saved = {
            let mut state = lock(&self.0.state);
            if let Some(rate) = rate.filter(|r| matches!(r, 30 | 60)) {
                state.recording_rate = rate;
            }
            if !state.profile_reports.iter().any(|r| r.0 == client)
                && state.profile_reports.len() >= 64
            {
                return Err(Error("Too many browser profile reporters (64).".into()));
            }
            state.profile_reports.retain(|r| r.0 != client);
            state.profile_reports.push((client, profiles, default));
            if let Err(error) = rebuild(&mut state) {
                state.profile_reports.retain(|r| r.0 != client);
                return Err(error);
            }
            json!({"profiles":state.profiles.iter().filter(|p| !matches!(p.get("id").and_then(Value::as_str),Some("default"|"incognito"))).collect::<Vec<_>>(),"defaultProfileId":state.default_profile})
        };
        let path = self
            .0
            .directory
            .join("server-browser/reported-profiles.json");
        tokio::task::spawn_blocking(move || {
            let bytes = serde_json::to_vec(&saved).map_err(crate::err)?;
            conn_support::fs::write_private(&path, &bytes).map_err(crate::err)
        })
        .await
        .map_err(crate::err)?
    }
    pub fn disconnect_client(&self, client: u64) {
        let mut state = lock(&self.0.state);
        state.profile_reports.retain(|r| r.0 != client);
        let _ = rebuild(&mut state);
    }
}
fn valid(profile: &Value) -> bool {
    profile
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty() && !s.chars().any(char::is_control))
        && profile
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
}
fn rebuild(state: &mut State) -> Result<(), Error> {
    if state.profile_reports.is_empty() {
        return Ok(());
    }
    let mut profiles = Vec::<Value>::new();
    let mut default = String::new();
    for (_, reported, current) in &state.profile_reports {
        for profile in reported {
            if let Some(existing) = profiles
                .iter_mut()
                .find(|p| p.get("id") == profile.get("id"))
            {
                *existing = profile.clone();
            } else {
                profiles.push(profile.clone());
            }
        }
        default.clone_from(current);
    }
    if profiles.len() > 256 {
        return Err(Error("Too many browser profiles (256 per server).".into()));
    }
    set_catalog(state, profiles, &default);
    Ok(())
}
fn set_catalog(state: &mut State, profiles: Vec<Value>, default: &str) {
    let mut all = spec().map(|s| s.profiles.clone()).unwrap_or_default();
    for mut profile in profiles {
        if all.iter().any(|p| p.get("id") == profile.get("id")) {
            continue;
        }
        profile["kind"] = json!("persistent");
        all.push(profile);
    }
    state.default_profile = Some(
        if all
            .iter()
            .any(|p| p.get("id").and_then(Value::as_str) == Some(default))
        {
            default.into()
        } else {
            "default".into()
        },
    );
    state.profiles = all;
}
