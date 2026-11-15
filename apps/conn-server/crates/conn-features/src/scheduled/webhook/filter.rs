//! Webhook filters: a request runs the task only when every filter matches. Follows
//! `webhookFilter.ts` in the T3 server; paths resolve as template placeholders do.

use conn_contract::{
    ScheduledTaskWebhookFilter, ScheduledTaskWebhookFilterEquals,
    ScheduledTaskWebhookFilterEqualsOp,
};

use super::template::{ExpressionResolver, Json, WebhookRequest, scalar_text};

/// The first filter a request fails: its index in the list and its path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailedFilter {
    pub index: usize,
    pub path: String,
}

fn path_of(filter: &ScheduledTaskWebhookFilter) -> &str {
    match filter {
        ScheduledTaskWebhookFilter::Equals(filter) => &filter.path,
        ScheduledTaskWebhookFilter::In(filter) => &filter.path,
        ScheduledTaskWebhookFilter::Exists(filter) => &filter.path,
    }
}

fn matches_scalar(filter: &ScheduledTaskWebhookFilter, text: &str) -> bool {
    match filter {
        ScheduledTaskWebhookFilter::Equals(ScheduledTaskWebhookFilterEquals {
            op, value, ..
        }) => match op {
            ScheduledTaskWebhookFilterEqualsOp::Equals => text == value,
            ScheduledTaskWebhookFilterEqualsOp::NotEquals => text != value,
            ScheduledTaskWebhookFilterEqualsOp::StartsWith => text.starts_with(value.as_str()),
        },
        ScheduledTaskWebhookFilter::In(filter) => filter.value.iter().any(|item| item == text),
        ScheduledTaskWebhookFilter::Exists(_) => true,
    }
}

fn is_not_equals(filter: &ScheduledTaskWebhookFilter) -> Option<&str> {
    match filter {
        ScheduledTaskWebhookFilter::Equals(ScheduledTaskWebhookFilterEquals {
            op: ScheduledTaskWebhookFilterEqualsOp::NotEquals,
            value,
            ..
        }) => Some(value),
        _ => None,
    }
}

/// Placeholders render null as missing, so filters treat it the same way. A path with a
/// `[]` wildcard resolves to a list: `equals`, `in` and `startsWith` match when any element
/// does, `notEquals` only when none equals the value, and `exists` when the list has an
/// element that is not null.
fn matches_webhook_filter(filter: &ScheduledTaskWebhookFilter, value: Option<&Json>) -> bool {
    let exists = matches!(filter, ScheduledTaskWebhookFilter::Exists(_));
    if let Some(Json::Array(elements)) = value
        && path_of(filter).contains("[]")
    {
        if exists {
            return elements.iter().any(|element| *element != Json::Null);
        }
        let mut texts = elements.iter().filter_map(scalar_text);
        if let Some(value) = is_not_equals(filter) {
            return texts.all(|text| text != value);
        }
        return texts.any(|text| matches_scalar(filter, &text));
    }
    if exists {
        return value.is_some_and(|value| *value != Json::Null);
    }
    value
        .and_then(scalar_text)
        .is_some_and(|text| matches_scalar(filter, &text))
}

/// The first filter the request fails, or `None` when every filter matches.
pub fn find_failed_webhook_filter(
    filters: &[ScheduledTaskWebhookFilter],
    request: &WebhookRequest,
) -> Option<FailedFilter> {
    let resolver = ExpressionResolver::new(request);
    filters.iter().enumerate().find_map(|(index, filter)| {
        let path = path_of(filter);
        let value = resolver.resolve(path);
        (!matches_webhook_filter(filter, value.as_ref())).then(|| FailedFilter {
            index,
            path: path.to_owned(),
        })
    })
}

/// Filters are numbered from 1, in the order the settings form lists them.
pub fn describe_failed_webhook_filter(failed: &FailedFilter) -> String {
    format!(
        "Filter {} ({}) did not match.",
        failed.index.saturating_add(1),
        failed.path
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_contract::{ScheduledTaskWebhookFilterExists, ScheduledTaskWebhookFilterIn, lit};

    fn issue_comment() -> WebhookRequest {
        WebhookRequest {
            method: "POST".to_owned(),
            path: "/api/hooks/task-1".to_owned(),
            query: String::new(),
            headers: vec![
                ("content-type".to_owned(), "application/json".to_owned()),
                ("x-github-event".to_owned(), "issue_comment".to_owned()),
            ],
            body_text: r#"{"action":"created","issue":{"number":7,"labels":[{"name":"bug"},{"name":"needs more info"}],"assignees":[]},"comment":{"user":{"login":"reporter","type":"User"}}}"#.to_owned(),
        }
    }

    fn with_body(body: &str) -> WebhookRequest {
        WebhookRequest {
            body_text: body.to_owned(),
            ..issue_comment()
        }
    }

    fn exists(path: &str) -> ScheduledTaskWebhookFilter {
        ScheduledTaskWebhookFilter::Exists(ScheduledTaskWebhookFilterExists {
            path: path.to_owned(),
            op: lit::Exists,
        })
    }

    fn compare(
        path: &str,
        op: ScheduledTaskWebhookFilterEqualsOp,
        value: &str,
    ) -> ScheduledTaskWebhookFilter {
        ScheduledTaskWebhookFilter::Equals(ScheduledTaskWebhookFilterEquals {
            path: path.to_owned(),
            op,
            value: value.to_owned(),
        })
    }

    fn one_of(path: &str, values: &[&str]) -> ScheduledTaskWebhookFilter {
        ScheduledTaskWebhookFilter::In(ScheduledTaskWebhookFilterIn {
            path: path.to_owned(),
            op: lit::In,
            value: values.iter().map(|value| (*value).to_owned()).collect(),
        })
    }

    fn failed(index: usize, path: &str) -> Option<FailedFilter> {
        Some(FailedFilter {
            index,
            path: path.to_owned(),
        })
    }

    use ScheduledTaskWebhookFilterEqualsOp::{Equals, NotEquals, StartsWith};

    #[test]
    fn matches_exists_on_wildcard_object_values() {
        assert_eq!(
            find_failed_webhook_filter(&[exists("body.issue.labels[]")], &issue_comment()),
            None,
            "labels"
        );
        assert_eq!(
            find_failed_webhook_filter(
                &[exists("body.issues[].labels")],
                &with_body(r#"{"issues":[{"labels":[]}]}"#)
            ),
            None,
            "issues"
        );
    }

    #[test]
    fn rejects_exists_when_wildcard_values_are_all_null_or_missing() {
        assert_eq!(
            find_failed_webhook_filter(
                &[exists("body.issues[].labels")],
                &with_body(r#"{"issues":[{"labels":null},{}]}"#)
            ),
            failed(0, "body.issues[].labels"),
            "null or missing"
        );
    }

    #[test]
    fn matches_a_wildcard_path_when_any_element_matches() {
        assert_eq!(
            find_failed_webhook_filter(
                &[
                    compare("body.issue.labels[].name", Equals, "needs more info"),
                    one_of("body.issue.labels[].name", &["needs more info", "triage"]),
                    compare("body.issue.labels[].name", StartsWith, "needs"),
                    exists("body.issue.labels[].name"),
                ],
                &issue_comment()
            ),
            None,
            "any element"
        );
        assert_eq!(
            find_failed_webhook_filter(
                &[compare("body.issue.labels[].name", Equals, "wontfix")],
                &issue_comment()
            ),
            failed(0, "body.issue.labels[].name"),
            "none"
        );
    }

    #[test]
    fn fails_not_equals_on_a_wildcard_path_when_any_element_equals_the_value() {
        assert_eq!(
            find_failed_webhook_filter(
                &[compare("body.issue.labels[].name", NotEquals, "bug")],
                &issue_comment()
            ),
            failed(0, "body.issue.labels[].name"),
            "bug"
        );
        assert_eq!(
            find_failed_webhook_filter(
                &[compare("body.issue.labels[].name", NotEquals, "wontfix")],
                &issue_comment()
            ),
            None,
            "wontfix"
        );
    }

    #[test]
    fn treats_an_empty_or_missing_wildcard_list_as_nothing_to_match() {
        assert_eq!(
            find_failed_webhook_filter(&[exists("body.issue.assignees[].login")], &issue_comment()),
            failed(0, "body.issue.assignees[].login"),
            "empty exists"
        );
        assert_eq!(
            find_failed_webhook_filter(
                &[compare("body.issue.assignees[].login", NotEquals, "anyone")],
                &issue_comment()
            ),
            None,
            "empty notEquals"
        );
        assert_eq!(
            find_failed_webhook_filter(&[exists("body.issue.number[].x")], &issue_comment()),
            failed(0, "body.issue.number[].x"),
            "not a list"
        );
    }

    #[test]
    fn still_compares_scalars_without_a_wildcard() {
        assert_eq!(
            find_failed_webhook_filter(
                &[
                    compare("body.action", Equals, "created"),
                    compare("body.comment.user.type", NotEquals, "Bot"),
                ],
                &issue_comment()
            ),
            None,
            "scalars"
        );
        // A list without a wildcard in the path only satisfies exists.
        assert_eq!(
            find_failed_webhook_filter(
                &[compare("body.issue.labels", Equals, "bug")],
                &issue_comment()
            ),
            failed(0, "body.issue.labels"),
            "list"
        );
    }

    #[test]
    fn compares_numbers_as_javascript_strings_and_describes_failures() {
        assert_eq!(
            find_failed_webhook_filter(
                &[
                    compare("body.issue.number", Equals, "7"),
                    exists("body.action")
                ],
                &issue_comment()
            ),
            None,
            "number"
        );
        assert_eq!(
            describe_failed_webhook_filter(&FailedFilter {
                index: 2,
                path: "body.action".to_owned()
            }),
            "Filter 3 (body.action) did not match.",
            "description"
        );
    }
}
