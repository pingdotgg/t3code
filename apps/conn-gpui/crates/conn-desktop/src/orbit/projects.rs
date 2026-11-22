//! First-party Orbit Projects client (`GET /api/v1/projects`).
//!
//! Orbit owns Projects as the single source of truth (`docs/scope.md` §5). This module provides a
//! GPUI-free, leniently parsed client over [`GatewayTransport`] so both `conn-gpui` and future
//! SwiftUI iOS targets can discover and resolve Orbit Projects without maintaining a separate
//! Conn-only project registry.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::gateway::{GatewayError, GatewayRequest, GatewayTransport, OrbitGateway};
use super::profile::{ProfileError, ProfileResult};

/// A first-party Orbit Project returned by Orbit Gateway (`GET /api/v1/projects`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitProject {
    pub id: i64,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub node_name: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub instance_count: usize,
}

impl OrbitProject {
    /// True when `query` matches this project's `slug` or `name` (trimmed, ASCII case-insensitive).
    #[must_use]
    pub fn matches_slug_or_name(&self, query: &str) -> bool {
        let needle = query.trim();
        !needle.is_empty()
            && (self.slug.eq_ignore_ascii_case(needle) || self.name.eq_ignore_ascii_case(needle))
    }
}

/// Finds a project by case-insensitive `slug`.
#[must_use]
pub fn find_project_by_slug<'a>(
    projects: &'a [OrbitProject],
    slug: &str,
) -> Option<&'a OrbitProject> {
    let needle = slug.trim();
    if needle.is_empty() {
        return None;
    }
    projects
        .iter()
        .find(|project| project.slug.eq_ignore_ascii_case(needle))
}

/// Finds a project by case-insensitive `name`.
#[must_use]
pub fn find_project_by_name<'a>(
    projects: &'a [OrbitProject],
    name: &str,
) -> Option<&'a OrbitProject> {
    let needle = name.trim();
    if needle.is_empty() {
        return None;
    }
    projects
        .iter()
        .find(|project| project.name.eq_ignore_ascii_case(needle))
}

/// Finds a project by `slug` first, falling back to `name` (both ASCII case-insensitive).
#[must_use]
pub fn find_project<'a>(
    projects: &'a [OrbitProject],
    slug_or_name: &str,
) -> Option<&'a OrbitProject> {
    find_project_by_slug(projects, slug_or_name)
        .or_else(|| find_project_by_name(projects, slug_or_name))
}

/// Client for reading first-party Orbit Projects over [`GatewayTransport`].
#[derive(Clone)]
pub struct OrbitProjectsClient {
    transport: Arc<dyn GatewayTransport>,
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<OrbitProjectsClient>();
};

impl std::fmt::Debug for OrbitProjectsClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrbitProjectsClient")
            .finish_non_exhaustive()
    }
}

impl OrbitProjectsClient {
    /// Builds a projects client backed by the live macOS [`OrbitGateway`].
    ///
    /// # Errors
    /// Returns [`GatewayError`] if the underlying HTTP client cannot be constructed.
    pub fn live() -> Result<Self, GatewayError> {
        Ok(Self::new(Arc::new(OrbitGateway::new()?)))
    }

    /// Builds a projects client backed by an arbitrary [`GatewayTransport`] (live or mock).
    #[must_use]
    pub fn new(transport: Arc<dyn GatewayTransport>) -> Self {
        Self { transport }
    }

    /// Lists all Orbit Projects visible to this Node (`GET /api/v1/projects`).
    ///
    /// # Errors
    /// Returns [`ProfileError::Unreachable`] on network failures, [`ProfileError::Gateway`] on
    /// non-2xx HTTP statuses, or [`ProfileError::InvalidResponse`] if the payload envelope is
    /// unrecognized.
    pub async fn list_projects(&self) -> ProfileResult<Vec<OrbitProject>> {
        let request = GatewayRequest::get("/projects").at_root();
        let path = request.path.clone();
        let response = self
            .transport
            .send(request)
            .await
            .map_err(|err| ProfileError::Unreachable(err.to_string()))?;

        let parsed: Option<Value> = serde_json::from_str(&response.body).ok();
        if !(200..300).contains(&response.status) {
            let err_obj = parsed
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|o| o.get("error"))
                .and_then(Value::as_object);
            let code = err_obj
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("gateway.request_failed")
                .to_owned();
            let message = err_obj
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map_or_else(
                    || format!("The Orbit Gateway answered {}.", response.status),
                    ToOwned::to_owned,
                );
            return Err(ProfileError::Gateway {
                code,
                message,
                status: response.status,
            });
        }

        let json = parsed.ok_or_else(|| ProfileError::InvalidResponse { path: path.clone() })?;
        decode_projects(&json).ok_or(ProfileError::InvalidResponse { path })
    }

    /// Fetches all projects and looks up one by `slug` (preferred) or `name`.
    ///
    /// # Errors
    /// Propagates any error from [`Self::list_projects`].
    pub async fn find_project(&self, slug_or_name: &str) -> ProfileResult<Option<OrbitProject>> {
        let projects = self.list_projects().await?;
        Ok(find_project(&projects, slug_or_name).cloned())
    }
}

/// Leniently decodes a Gateway projects response envelope.
///
/// Accepts:
/// - `{ "data": [ ... ] }`
/// - `{ "data": { "projects": [ ... ] } }`
/// - `{ "projects": [ ... ] }`
/// - `[ ... ]`
///
/// Individual malformed rows are skipped rather than failing the whole list, matching `tasks.rs`
/// and `fleet.rs` conventions.
#[must_use]
pub fn decode_projects(json: &Value) -> Option<Vec<OrbitProject>> {
    let rows = json
        .get("data")
        .and_then(|data| {
            data.as_array()
                .or_else(|| data.get("projects").and_then(Value::as_array))
        })
        .or_else(|| json.get("projects").and_then(Value::as_array))
        .or_else(|| json.as_array())?;

    Some(rows.iter().filter_map(decode_project).collect())
}

fn optional_text(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn decode_project(value: &Value) -> Option<OrbitProject> {
    let obj = value.as_object()?;
    let id = obj.get("id").and_then(Value::as_i64)?;
    let slug = optional_text(obj.get("slug"))?;
    let name = optional_text(obj.get("name")).unwrap_or_else(|| slug.clone());
    let repository = optional_text(
        obj.get("repository")
            .or_else(|| obj.get("repository_url"))
            .or_else(|| obj.get("repo")),
    );
    let node_name = optional_text(
        obj.get("node_name")
            .or_else(|| obj.get("default_node_name")),
    )
    .or_else(|| {
        obj.get("node")
            .and_then(|node| optional_text(Some(node)).or_else(|| optional_text(node.get("name"))))
    });
    let icon = optional_text(obj.get("icon"));
    let color = optional_text(obj.get("color"));
    let instance_count = obj
        .get("instance_count")
        .or_else(|| obj.get("instances_count"))
        .and_then(Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .or_else(|| obj.get("instances").and_then(Value::as_array).map(Vec::len))
        .unwrap_or(0);

    Some(OrbitProject {
        id,
        slug,
        name,
        repository,
        node_name,
        icon,
        color,
        instance_count,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::orbit::gateway::{BoxFuture, GatewayMethod, GatewayResponse};

    struct MockGateway {
        handler:
            Mutex<Box<dyn FnMut(GatewayRequest) -> Result<GatewayResponse, GatewayError> + Send>>,
    }

    impl MockGateway {
        fn new(
            f: impl FnMut(GatewayRequest) -> Result<GatewayResponse, GatewayError> + Send + 'static,
        ) -> Arc<Self> {
            Arc::new(Self {
                handler: Mutex::new(Box::new(f)),
            })
        }
    }

    impl GatewayTransport for MockGateway {
        fn send(
            &self,
            request: GatewayRequest,
        ) -> BoxFuture<'_, Result<GatewayResponse, GatewayError>> {
            let res = (self.handler.lock().expect("mock gateway lock poisoned"))(request);
            Box::pin(async move { res })
        }
    }

    #[tokio::test]
    async fn lists_projects_from_data_envelope_at_root_api_route() {
        let body = json!({
            "data": [
                {
                    "id": 78,
                    "slug": "orbit",
                    "name": "Orbit",
                    "repository_url": "https://github.com/hardimpactdev/orbit.git",
                    "node": { "id": 9, "name": "beast" },
                    "icon": "globe",
                    "color": "#3b82f6",
                    "instances_count": 4
                },
                {
                    "id": 33,
                    "slug": "conn-gpui",
                    "name": "Conn GPUI",
                    "repository": "git@github.com:nckrtl/conn-gpui.git",
                    "node_name": "mini",
                    "instances": [{ "id": 1 }, { "id": 2 }]
                }
            ]
        })
        .to_string();

        let transport = MockGateway::new(move |req| {
            assert_eq!(req.method, GatewayMethod::Get);
            assert!(req.root);
            assert_eq!(req.path, "/projects");
            Ok(GatewayResponse {
                status: 200,
                body: body.clone(),
            })
        });

        let client = OrbitProjectsClient::new(transport);
        let projects = client.list_projects().await.expect("list_projects");
        assert_eq!(projects.len(), 2);

        assert_eq!(projects[0].id, 78);
        assert_eq!(projects[0].slug, "orbit");
        assert_eq!(projects[0].name, "Orbit");
        assert_eq!(
            projects[0].repository.as_deref(),
            Some("https://github.com/hardimpactdev/orbit.git")
        );
        assert_eq!(projects[0].node_name.as_deref(), Some("beast"));
        assert_eq!(projects[0].icon.as_deref(), Some("globe"));
        assert_eq!(projects[0].color.as_deref(), Some("#3b82f6"));
        assert_eq!(projects[0].instance_count, 4);

        assert_eq!(projects[1].id, 33);
        assert_eq!(projects[1].slug, "conn-gpui");
        assert_eq!(projects[1].name, "Conn GPUI");
        assert_eq!(
            projects[1].repository.as_deref(),
            Some("git@github.com:nckrtl/conn-gpui.git")
        );
        assert_eq!(projects[1].node_name.as_deref(), Some("mini"));
        assert_eq!(projects[1].icon, None);
        assert_eq!(projects[1].color, None);
        assert_eq!(projects[1].instance_count, 2);
    }

    #[tokio::test]
    async fn parses_projects_envelope_and_handles_missing_optional_fields() {
        let body = json!({
            "projects": [
                {
                    "id": 46,
                    "slug": "orbit-website"
                },
                {
                    "id": 99,
                    "slug": "   ",
                    "name": "Invalid blank slug"
                },
                {
                    "slug": "missing-id"
                },
                {
                    "id": 50,
                    "slug": "dlf",
                    "name": "   ",
                    "repository": "  ",
                    "node_name": null,
                    "icon": "",
                    "color": "   ",
                    "instance_count": 0
                }
            ]
        })
        .to_string();

        let transport = MockGateway::new(move |_| {
            Ok(GatewayResponse {
                status: 200,
                body: body.clone(),
            })
        });

        let client = OrbitProjectsClient::new(transport);
        let projects = client.list_projects().await.expect("list_projects");
        assert_eq!(projects.len(), 2);

        assert_eq!(
            projects[0],
            OrbitProject {
                id: 46,
                slug: "orbit-website".to_owned(),
                name: "orbit-website".to_owned(),
                repository: None,
                node_name: None,
                icon: None,
                color: None,
                instance_count: 0,
            }
        );
        assert_eq!(
            projects[1],
            OrbitProject {
                id: 50,
                slug: "dlf".to_owned(),
                name: "dlf".to_owned(),
                repository: None,
                node_name: None,
                icon: None,
                color: None,
                instance_count: 0,
            }
        );
    }

    #[test]
    fn decodes_nested_data_projects_envelope_and_rejects_non_list() {
        let nested = json!({
            "data": {
                "projects": [
                    { "id": 1, "slug": "alpha", "name": "Alpha", "instance_count": 3 }
                ]
            }
        });
        let decoded = decode_projects(&nested).expect("nested envelope");
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].slug, "alpha");
        assert_eq!(decoded[0].instance_count, 3);

        assert_eq!(decode_projects(&json!({ "data": "not-a-list" })), None);
        assert_eq!(decode_projects(&json!({ "other": [] })), None);
    }

    #[tokio::test]
    async fn looks_up_projects_by_slug_and_name_case_insensitively() {
        let body = json!({
            "data": [
                { "id": 1, "slug": "orbit", "name": "Orbit Control Plane" },
                { "id": 2, "slug": "conn", "name": "Orbit" }
            ]
        })
        .to_string();

        let transport = MockGateway::new(move |_| {
            Ok(GatewayResponse {
                status: 200,
                body: body.clone(),
            })
        });
        let client = OrbitProjectsClient::new(transport);
        let projects = client.list_projects().await.expect("list");

        // Exact slug match wins over another project's name match.
        assert_eq!(
            find_project(&projects, "ORBIT").map(|p| p.id),
            Some(1),
            "slug match should take priority over name match"
        );
        assert_eq!(
            find_project(&projects, "  orbit control plane  ").map(|p| p.id),
            Some(1)
        );
        assert_eq!(
            find_project_by_slug(&projects, "CONN").map(|p| p.id),
            Some(2)
        );
        assert_eq!(
            find_project_by_name(&projects, "orbit").map(|p| p.id),
            Some(2)
        );
        assert_eq!(find_project(&projects, "   "), None);
        assert_eq!(find_project(&projects, "unknown"), None);
        assert!(projects[0].matches_slug_or_name("Orbit"));
        assert!(projects[0].matches_slug_or_name("orbit control plane"));
        assert!(!projects[0].matches_slug_or_name(""));

        let found = client
            .find_project("conn")
            .await
            .expect("client find_project");
        assert_eq!(found.map(|p| p.id), Some(2));
    }

    #[tokio::test]
    async fn reports_gateway_and_transport_errors() {
        let err_transport = MockGateway::new(|_| {
            Ok(GatewayResponse {
                status: 403,
                body: json!({
                    "error": { "code": "peer.identity_unknown", "message": "Not an Orbit Node." }
                })
                .to_string(),
            })
        });
        let err = OrbitProjectsClient::new(err_transport)
            .list_projects()
            .await
            .expect_err("expected gateway error");
        assert_eq!(
            err,
            ProfileError::Gateway {
                code: "peer.identity_unknown".to_owned(),
                message: "Not an Orbit Node.".to_owned(),
                status: 403,
            }
        );

        let down_transport = MockGateway::new(|_| Err(GatewayError::Timeout));
        let err = OrbitProjectsClient::new(down_transport)
            .list_projects()
            .await
            .expect_err("expected unreachable");
        assert!(matches!(err, ProfileError::Unreachable(_)));
    }
}
