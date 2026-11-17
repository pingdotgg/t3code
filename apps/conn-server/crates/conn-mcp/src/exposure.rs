//! Catalog search and deferred listing, bounded by provider sessions (`McpToolExposure.ts`).

use crate::catalog;
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};

mod generated;
use generated::{DIRECT, MAX_RESULTS, MAX_SESSIONS};

const SEARCH_ORDER: &str = include_str!("../fixtures/t3-tool-names.txt");

#[derive(Default)]
pub(crate) struct Exposure {
    loaded: VecDeque<(String, HashSet<String>)>,
}

impl Exposure {
    pub(crate) fn listed(&self, session: &str, tool: &str) -> bool {
        DIRECT.contains(&tool)
            || self
                .loaded
                .iter()
                .find(|(id, _)| id == session)
                .is_some_and(|(_, tools)| tools.contains(tool))
    }

    pub(crate) fn search(&mut self, session: &str, query: &str) -> Vec<Value> {
        let query = query.to_lowercase();
        let terms: Vec<_> = query
            .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit() && c != '_')
            .filter(|s| !s.is_empty())
            .collect();
        let mut matches: Vec<_> = catalog::lines()
            .filter_map(|line| {
                let tool: Value = serde_json::from_str(line).ok()?;
                let name = tool["name"].as_str()?;
                if name == "tool_search" {
                    return None;
                }
                let description = tool["description"].as_str().unwrap_or_default();
                let (lower_name, lower_description) =
                    (name.to_lowercase(), description.to_lowercase());
                let score: usize = terms
                    .iter()
                    .map(|term| {
                        if *term == lower_name {
                            100
                        } else if lower_name.contains(term) {
                            3
                        } else if lower_description.contains(term) {
                            1
                        } else {
                            0
                        }
                    })
                    .sum();
                (score > 0).then(|| (score, json!({"name":name,"description":description})))
            })
            .collect();
        matches.sort_by_key(|(score, tool)| {
            (
                std::cmp::Reverse(*score),
                SEARCH_ORDER
                    .lines()
                    .position(|name| tool["name"] == name)
                    .unwrap_or(usize::MAX),
            )
        });
        let found: Vec<Value> = matches
            .into_iter()
            .take(MAX_RESULTS)
            .map(|(_, v)| v)
            .collect();
        if !found.is_empty() {
            let mut tools = self
                .loaded
                .iter()
                .position(|(id, _)| id == session)
                .and_then(|index| self.loaded.remove(index))
                .map(|(_, set)| set)
                .unwrap_or_default();
            tools.extend(
                found
                    .iter()
                    .filter_map(|t| t["name"].as_str().map(str::to_owned)),
            );
            self.loaded.push_back((session.to_owned(), tools));
            while self.loaded.len() > MAX_SESSIONS {
                self.loaded.pop_front();
            }
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_matches_t3_ordering_and_direct_tool_visibility() {
        let reference: Value =
            serde_json::from_str(include_str!("../fixtures/tool-search.json")).unwrap();
        let mut exposure = Exposure::default();
        let listed: Vec<_> = catalog::names()
            .filter(|name| exposure.listed("search-test", name))
            .collect();
        assert_eq!(json!(listed), reference["initiallyListed"]);
        for case in reference["cases"].as_array().unwrap() {
            let query = case["query"].as_str().unwrap();
            let names: Vec<_> = exposure
                .search("search-test", query)
                .into_iter()
                .map(|tool| tool["name"].clone())
                .collect();
            assert_eq!(json!(names), case["names"], "query: {query}");
        }
    }

    #[test]
    fn search_loads_exact_names_and_evicts_the_oldest_session() {
        let mut exposure = Exposure::default();
        assert!(!exposure.listed("s", "t3_workflow_stop"));
        assert!(exposure.listed("s", "delegate_task"));
        let found = exposure.search("s", "T3_WORKFLOW_STOP");
        assert_eq!(found.first().unwrap()["name"], "t3_workflow_stop");
        assert!(exposure.listed("s", "t3_workflow_stop"));
        assert!(!exposure.listed("other", "t3_workflow_stop"));
        assert!(exposure.search("s", "@!!").is_empty());
        assert!(exposure.search("s", "thread").len() <= MAX_RESULTS);
        for i in 0..MAX_SESSIONS {
            exposure.search(&i.to_string(), "t3_project_read");
        }
        assert!(!exposure.listed("s", "t3_workflow_stop"));
        assert_eq!(exposure.loaded.len(), MAX_SESSIONS);
        let reference: Value =
            serde_json::from_str(include_str!("../fixtures/tool-search.json")).unwrap();
        assert_eq!(json!(exposure.loaded.len()), reference["retainedSessions"]);
    }
}
