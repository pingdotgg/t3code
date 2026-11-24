//! Locations in the thread's workspace. Lines are one-based and inclusive.
use serde::{Deserialize, Serialize};
use std::ops::Range;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLines {
    pub start_line: usize,
    pub end_line: usize,
}

impl SourceLines {
    pub fn bytes(self, text: &str) -> Option<Range<usize>> {
        if self.start_line == 0 || self.end_line < self.start_line {
            return None;
        }
        let mut offset = 0;
        let mut start = None;
        for (index, line) in text.split('\n').enumerate() {
            let number = index + 1;
            if number == self.start_line {
                start = Some(offset);
            }
            if number == self.end_line {
                return Some(start?..offset + line.trim_end_matches('\r').len());
            }
            offset += line.len() + 1;
        }
        None
    }

    pub fn from_selection(text: &str, bytes: Range<usize>) -> Option<Self> {
        let prefix = text.get(..bytes.start)?;
        let selected = text.get(bytes)?;
        if selected.is_empty() {
            return None;
        }
        let start_line = 1 + prefix.bytes().filter(|&b| b == b'\n').count();
        let end_line = start_line
            + selected
                .strip_suffix('\n')
                .unwrap_or(selected)
                .bytes()
                .filter(|&b| b == b'\n')
                .count();
        Some(Self {
            start_line,
            end_line,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSelection {
    pub path: String,
    #[serde(flatten)]
    pub lines: SourceLines,
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_round_trips_unicode_and_crlf_without_selecting_the_next_line() {
        let text = "first\r\né🦀\r\nlast\n";
        let start = text.find('é').unwrap();
        let end = text.find("last").unwrap();
        let lines = SourceLines::from_selection(text, start..end).unwrap();
        assert_eq!(
            lines,
            SourceLines {
                start_line: 2,
                end_line: 2
            }
        );
        assert_eq!(&text[lines.bytes(text).unwrap()], "é🦀");
        assert!(
            SourceLines {
                start_line: 4,
                end_line: 5
            }
            .bytes(text)
            .is_none()
        );
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FilesAction {
    Selection,
    Reveal {
        path: String,
        #[serde(flatten)]
        lines: SourceLines,
        excerpt: String,
    },
}

/// Native extensions to the shared panel frames. Older clients subscribe without a files thread.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPanelRequest {
    #[serde(flatten)]
    pub panel: crate::AgentPanelRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_action: Option<FilesAction>,
}

impl std::ops::Deref for DesktopPanelRequest {
    type Target = crate::AgentPanelRequest;
    fn deref(&self) -> &Self::Target {
        &self.panel
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPanelResponse {
    #[serde(flatten)]
    pub panel: crate::AgentPanelResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<SourceSelection>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPanelSubscription {
    #[serde(flatten)]
    pub panel: crate::AgentPanelSubscribeInput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_thread: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub files_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceLocation {
    pub path: String,
    pub lines: Option<SourceLines>,
}

pub fn workspace_relative(path: &str) -> bool {
    !path.is_empty()
        && path != "~"
        && !path.starts_with("~/")
        && !path.contains(['\0', '\\'])
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

/// One-based line and UTF-16 column in a workspace-relative PHP file.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionQuery {
    pub path: String,
    pub line: u32,
    pub column: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_line: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionRequest {
    pub thread_id: String,
    #[serde(flatten)]
    pub query: DefinitionQuery,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparePhpNavigation {
    pub thread_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionTarget {
    pub path: String,
    #[serde(flatten)]
    pub lines: SourceLines,
}
