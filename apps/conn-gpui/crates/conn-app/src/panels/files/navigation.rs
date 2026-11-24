//! Speculative lookups belong to the displayed file. Only a click may open a tab.
use super::{FilesEvent, FilesPanel, PreviewState};
use conn_contract::{
    ProjectReadFileInput, ProjectReadFileResult,
    rpc::projects::read_file,
    source::{DefinitionQuery, DefinitionRequest, SourceLines, SourceLocation},
};
use gpui_kit::{Context, EntityInputHandler as _, Pixels, Point, Task, Window};
use std::time::{Duration, Instant};

type Destination = Result<(SourceLocation, Option<ProjectReadFileResult>), String>;

pub(super) struct Lookup {
    symbol: (u32, u32),
    clicked: bool,
    started: bool,
    ready: Option<(Instant, Destination)>,
    _task: Task<()>,
}

#[cfg(feature = "automation")]
impl Lookup {
    pub(super) fn has_target(&self) -> bool {
        matches!(&self.ready, Some((_, Ok((_, Some(_))))))
    }
}

impl FilesPanel {
    pub(in crate::panels) fn cancel_hover(&mut self) {
        if self
            .definition_lookup
            .as_ref()
            .is_some_and(|entry| !entry.clicked)
        {
            self.definition_lookup = None;
        }
    }

    pub(in crate::panels) fn zed_definition_at(
        &mut self,
        position: Point<Pixels>,
        click: bool,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let (
            PreviewState::Loaded {
                path, raw_contents, ..
            },
            Some(editor),
            Some(conn),
            Some(thread),
            Some(cwd),
        ) = (
            &self.preview,
            &self.zed,
            self.connection.clone(),
            self.thread.clone(),
            self.workspace_root.clone(),
        )
        else {
            return;
        };
        let point =
            editor.update(cx, |editor, cx| {
                let index = editor.character_index_for_point(position, window, cx)?;
                let buffer = editor.buffer().read(cx).as_singleton()?;
                let buffer = buffer.read(cx);
                Some(buffer.offset_to_point_utf16(
                    buffer.offset_utf16_to_offset(zed_text::OffsetUtf16(index)),
                ))
            });
        let Some((point, line)) =
            point.and_then(|p| Some((p, raw_contents.lines().nth(p.row as usize)?)))
        else {
            self.cancel_hover();
            return;
        };
        let column = match symbol_start(line, point.column) {
            Some(start) => start,
            None if click => point.column,
            None => {
                self.cancel_hover();
                return;
            }
        };
        let passive = !click && window.modifiers() != gpui_kit::Modifiers::command();
        if passive && !is_method_call(line, column) {
            self.cancel_hover();
            return;
        }
        let symbol = (point.row, column);
        if click {
            cx.stop_propagation();
        }
        if let Some(entry) = &mut self.definition_lookup {
            if !click && entry.clicked {
                return;
            }
            if entry.symbol == symbol
                && entry
                    .ready
                    .as_ref()
                    .is_none_or(|(at, _)| at.elapsed() < Duration::from_secs(5))
            {
                if !click {
                    return;
                }
                if let Some((_, result)) = entry.ready.take() {
                    if result.is_ok() {
                        self.definition_lookup = None;
                        self.open_definition(result, cx);
                        return;
                    }
                } else if entry.started {
                    entry.clicked = true;
                    return;
                }
            }
        }
        let query = DefinitionRequest {
            thread_id: thread.clone(),
            query: DefinitionQuery {
                path: path.clone(),
                line: point.row + 1,
                column: column + 1,
                expected_line: Some(line.to_owned()),
            },
        };
        let path = path.clone();
        let generation = self.preview_generation;
        let task = cx.spawn(async move |this, cx| {
            if !click {
                cx.background_executor()
                    .timer(Duration::from_millis(if passive { 180 } else { 90 }))
                    .await;
                let _ = this.update(cx, |panel, _| {
                    if let Some(entry) = &mut panel.definition_lookup {
                        entry.started = true;
                    }
                });
            }
            let destination = async {
                let mut targets = conn.first_source_definition(query.clone(), !click).await;
                if !click
                    && !targets.as_ref().is_ok_and(|targets| !targets.is_empty())
                    && this
                        .update(cx, |panel, _| {
                            panel
                                .definition_lookup
                                .as_ref()
                                .is_some_and(|entry| entry.clicked)
                        })
                        .unwrap_or(false)
                {
                    targets = conn.first_source_definition(query, false).await;
                }
                let target = targets
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .next()
                    .ok_or_else(|| "No definition found here.".to_owned())?;
                let target_path = target.path;
                let cached = click
                    && this
                        .update(cx, |panel, _| {
                            panel
                                .recent_text
                                .iter()
                                .any(|file| file.path() == Some(&target_path))
                        })
                        .unwrap_or(false);
                let contents = if !cached && target_path != path {
                    conn.call::<read_file::Payload, read_file::Success>(
                        "projects.readFile",
                        &ProjectReadFileInput {
                            cwd,
                            relative_path: target_path.clone(),
                            allow_missing: None,
                        },
                    )
                    .await
                    .ok()
                } else {
                    None
                };
                Ok((
                    SourceLocation {
                        path: target_path,
                        lines: Some(SourceLines {
                            start_line: target.lines.start_line,
                            end_line: target.lines.start_line,
                        }),
                    },
                    contents,
                ))
            }
            .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.preview_generation != generation || !panel.is_showing(&thread, &path) {
                    return;
                }
                if let Some(entry) = &mut panel.definition_lookup {
                    if entry.clicked {
                        panel.definition_lookup = None;
                        panel.open_definition(destination, cx);
                    } else {
                        entry.ready = Some((Instant::now(), destination));
                    }
                }
            });
        });
        self.definition_lookup = Some(Lookup {
            symbol,
            clicked: click,
            started: click,
            ready: None,
            _task: task,
        });
    }

    fn open_definition(&mut self, destination: Destination, cx: &mut Context<'_, Self>) {
        match destination {
            Ok((location, contents)) => {
                self.definition_file = contents;
                self.range_error = None;
                cx.emit(FilesEvent::Definition(location));
            }
            Err(error) => self.definition_error(error, cx),
        }
    }
}

// Key a hover by the identifier, so moving between letters shares the same request.
fn symbol_start(line: &str, column: u32) -> Option<u32> {
    let mut unit = 0;
    let mut start = None;
    for ch in line.chars() {
        if ch == '_' || ch.is_alphanumeric() || !ch.is_ascii() {
            start.get_or_insert(unit);
        } else {
            start = None;
        }
        unit += ch.len_utf16() as u32;
        if unit > column {
            return start;
        }
    }
    None
}

// Plain pointer hover is speculative only on PHP member calls. Phpactor resolves the receiver.
fn is_method_call(line: &str, column: u32) -> bool {
    let mut units = 0;
    let Some((byte, _)) = line.char_indices().find(|(_, ch)| {
        let start = units;
        units += ch.len_utf16() as u32;
        start == column
    }) else {
        return false;
    };
    let prefix = line[..byte].trim_end();
    (prefix.ends_with("->") || prefix.ends_with("::"))
        && line[byte..]
            .trim_start_matches(|ch: char| ch == '_' || ch.is_alphanumeric() || !ch.is_ascii())
            .trim_start()
            .starts_with('(')
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hover_shares_identifiers_in_utf16_columns() {
        let line = "/*🦀*/ Cläss::run";
        assert_eq!(symbol_start(line, 7), Some(7));
        assert_eq!(symbol_start(line, 11), Some(7));
        assert_eq!(symbol_start(line, 12), None);
        assert_eq!(symbol_start(line, 16), Some(14));
        assert!(is_method_call("/*🦀*/ Cläss::run()", 14));
        assert!(is_method_call("    ?->columns ([", 7));
        assert!(!is_method_call("    ->columns;", 6));
        assert!(!is_method_call("function columns()", 9));
    }
}
