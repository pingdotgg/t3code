//! Cmd-click resolves in the connected workspace and opens its returned Files tab.
use super::files::{FilesEvent, FilesPanel};
use conn_client::Connection;
use conn_contract::source::{
    DefinitionQuery, DefinitionRequest, DefinitionTarget, SourceLines, SourceLocation,
    workspace_relative,
};
use gpui_kit::{
    App, Task, WeakEntity, Window,
    component::input::{DefinitionProvider, EditorState, Rope, RopeExt},
};
use lsp_types::{LocationLink, Position, Range};
use std::rc::Rc;

pub(super) fn configure(
    editor: &mut EditorState,
    conn: Connection,
    thread: String,
    path: String,
    panel: WeakEntity<FilesPanel>,
) {
    let provider = Definitions {
        conn,
        thread: thread.clone(),
        path: path.clone(),
        panel: panel.clone(),
    };
    editor.lsp_mut().definition_provider = Some(Rc::new(provider));
    editor.lsp_mut().show_document = Some(Rc::new(move |params, _, cx| {
        let Some(range) = params.selection else {
            return true;
        };
        let Some(target) = url::Url::parse(params.uri.as_str())
            .ok()
            .and_then(|uri| uri.to_file_path().ok())
        else {
            return true;
        };
        let Some(relative) = target
            .strip_prefix("/")
            .ok()
            .and_then(|s| s.to_str())
            .filter(|s| workspace_relative(s))
        else {
            return true;
        };
        let _ = panel.update(cx, |p, cx| {
            if p.is_showing(&thread, &path) {
                cx.emit(FilesEvent::Definition(SourceLocation {
                    path: relative.into(),
                    lines: Some(SourceLines {
                        start_line: range.start.line as usize + 1,
                        end_line: range.end.line as usize + 1,
                    }),
                }));
            }
        });
        true
    }));
}

struct Definitions {
    conn: Connection,
    thread: String,
    path: String,
    panel: WeakEntity<FilesPanel>,
}

impl DefinitionProvider for Definitions {
    fn definitions(
        &self,
        text: &Rope,
        offset: usize,
        _: &mut Window,
        cx: &mut App,
    ) -> Task<gpui_kit::Result<Vec<LocationLink>>> {
        let point = text.offset_to_point(offset);
        let column = text.slice_line(point.row).byte_to_utf16_idx(point.column);
        let query = DefinitionRequest {
            thread_id: self.thread.clone(),
            query: DefinitionQuery {
                path: self.path.clone(),
                line: point.row as u32 + 1,
                column: column as u32 + 1,
                expected_line: Some(
                    text.slice_line(point.row)
                        .to_string()
                        .trim_end_matches(['\r', '\n'])
                        .to_owned(),
                ),
            },
        };
        let conn = self.conn.clone();
        let panel = self.panel.clone();
        cx.spawn(
            async move |cx| match conn.source_definition(query.clone()).await {
                Ok(targets) => targets.into_iter().map(link).collect(),
                Err(e) => {
                    let _ = panel.update(cx, |p, cx| {
                        if p.is_showing(&query.thread_id, &query.query.path) {
                            p.definition_error(e.to_string(), cx);
                        }
                    });
                    Ok(vec![])
                }
            },
        )
    }
}

fn link(target: DefinitionTarget) -> gpui_kit::Result<LocationLink> {
    let url = url::Url::from_file_path(std::path::Path::new("/").join(target.path))
        .map_err(|_| std::io::Error::other("Invalid workspace file path"))?;
    let range = Range::new(
        Position::new(
            u32::try_from(
                target
                    .lines
                    .start_line
                    .checked_sub(1)
                    .ok_or_else(|| std::io::Error::other("Invalid target line"))?,
            )?,
            0,
        ),
        Position::new(
            u32::try_from(
                target
                    .lines
                    .end_line
                    .checked_sub(1)
                    .ok_or_else(|| std::io::Error::other("Invalid target line"))?,
            )?,
            0,
        ),
    );
    Ok(LocationLink {
        origin_selection_range: None,
        target_uri: url.as_str().parse()?,
        target_range: range,
        target_selection_range: range,
    })
}
