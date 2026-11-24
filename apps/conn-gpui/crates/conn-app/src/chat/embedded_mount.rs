//! Mount a document only for the lifetime of its virtualized timeline row. A connection change
//! invalidates the mount even when two environments use the same thread or attachment id.
use conn_client::Connection;
use conn_theme::Tokens;
use gpui_kit::{
    AnyElement, App, AppContext as _, Entity, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled, Window, div, px,
};

use super::ChatView;
use super::embedded_document::{
    EmbeddedDocumentCard, EmbeddedDocumentFacts, EmbeddedVideoCard, EmbeddedVideoFacts,
};

#[derive(IntoElement)]
struct DocumentMount {
    key: SharedString,
    facts: EmbeddedDocumentFacts,
    conversation_thread: String,
    tokens: Tokens,
    connection: Option<Connection>,
}

impl RenderOnce for DocumentMount {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let mount = window.use_keyed_state(self.key, cx, |window, cx| {
            let card = cx.new(|cx| {
                let mut card = EmbeddedDocumentCard::new(
                    self.facts.clone(),
                    self.tokens.clone(),
                    self.connection,
                    window,
                    cx,
                );
                card.set_conversation_thread_id(Some(self.conversation_thread), cx);
                card.set_visible(true, cx);
                card
            });
            (card, self.tokens.clone(), self.facts.clone())
        });
        mount.update(cx, |(card, tokens, facts), cx| {
            if self.tokens != *tokens {
                card.update(cx, |card, cx| card.set_tokens(self.tokens.clone(), cx));
                *tokens = self.tokens;
            }
            if self.facts != *facts {
                card.update(cx, |card, cx| card.set_facts(self.facts.clone(), cx));
                *facts = self.facts;
            }
            card.clone()
        })
    }
}

#[derive(IntoElement)]
struct VideoMount {
    key: SharedString,
    facts: EmbeddedVideoFacts,
    tokens: Tokens,
    connection: Option<Connection>,
}

impl RenderOnce for VideoMount {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let mount: Entity<(Entity<EmbeddedVideoCard>, Tokens)> =
            window.use_keyed_state(self.key, cx, |window, cx| {
                let card = cx.new(|cx| {
                    let mut card = EmbeddedVideoCard::new(
                        self.facts,
                        self.tokens.clone(),
                        self.connection,
                        window,
                        cx,
                    );
                    card.set_visible(true, cx);
                    card
                });
                (card, self.tokens.clone())
            });
        let child = mount.update(cx, |(card, tokens), cx| {
            if self.tokens != *tokens {
                card.update(cx, |card, cx| card.set_tokens(self.tokens.clone(), cx));
                *tokens = self.tokens;
            }
            card.clone()
        });
        div()
            .relative()
            .w_full()
            .aspect_ratio(4.0 / 3.0)
            .rounded(px(11.0))
            .overflow_hidden()
            .child(div().absolute().inset_0().child(child))
    }
}

impl ChatView {
    pub(super) fn render_sent_video(
        &self,
        key: &str,
        idx: usize,
        id: &str,
        name: &str,
        mime_type: &str,
    ) -> AnyElement {
        VideoMount {
            key: format!("video-{}-{key}-{idx}-{id}", self.mount_epoch).into(),
            facts: EmbeddedVideoFacts {
                attachment_id: id.to_owned(),
                name: name.to_owned(),
                mime_type: mime_type.to_owned(),
            },
            tokens: self.tokens.clone(),
            connection: self.connection.clone(),
        }
        .into_any_element()
    }

    pub(super) fn render_embedded_document(&self, entry: &conn_state::TimelineEntry) -> AnyElement {
        let conn_state::TimelineEntry::EmbeddedDocument {
            id,
            title,
            document,
            is_mcp,
            input,
            output,
            output_omitted,
            source_thread_id,
            source_item_id,
            ..
        } = entry
        else {
            return div().into_any_element();
        };
        let Some(thread_id) = self.thread_id.as_ref() else {
            return div().into_any_element();
        };
        let attachment = document["attachmentId"].as_str().unwrap_or_default();
        DocumentMount {
            key: format!(
                "document-{}-{thread_id}-{id}-{attachment}",
                self.mount_epoch
            )
            .into(),
            conversation_thread: thread_id.clone(),
            facts: EmbeddedDocumentFacts {
                thread_id: source_thread_id.clone(),
                item_id: source_item_id.clone(),
                title: title.clone(),
                document: document.clone(),
                is_mcp: *is_mcp,
                tool_input: (!*output_omitted && !input.is_null()).then(|| input.clone()),
                tool_result: output.get("result").cloned(),
            },
            tokens: self.tokens.clone(),
            connection: self.connection.clone(),
        }
        .into_any_element()
    }
}
