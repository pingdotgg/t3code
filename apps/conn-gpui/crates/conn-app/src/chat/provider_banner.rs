//! The provider status banner above the thread (`ProviderStatusBanner.tsx`).
//!
//! Shown while the composer's provider is warning or failing: its title, the server's status
//! line, a compatibility note, `Open provider setup` (Antigravity, or a provider that signs in
//! through the server) and `Refresh`. A dismissal lasts the session and the environment; a new
//! status (another message or auth state) raises the banner again.

use std::sync::Arc;

use conn_state::providers::{ProviderBanner, ServerConfigState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};

use super::color::{hsla, hsla_alpha};
use super::{ChatEvent, ChatView, icons};
use crate::a11y::ConnA11yExt as _;

/// `max-w-[calc(100%-2rem)]` of a `w-fit` alert; the banner never outgrows the chat lane.
const BANNER_MAX_WIDTH_PX: f32 = 640.0;

impl ChatView {
    /// Takes the app's latest server config for the composer and the banner.
    pub(crate) fn set_server_config(
        &mut self,
        config: Arc<ServerConfigState>,
        cx: &mut Context<'_, Self>,
    ) {
        self.server_config = Arc::clone(&config);
        self.composer
            .update(cx, |composer, cx| composer.set_server_config(config, cx));
        cx.notify();
    }

    /// Scopes banner dismissals to one environment (`getProviderStatusDismissalKey`): built-in
    /// instance ids such as `codex` repeat across environments.
    pub(crate) fn set_environment_key(&mut self, key: Option<String>) {
        self.environment_key = key;
    }

    /// The banner for the composer's provider, unless the user dismissed this status.
    fn visible_provider_banner(&self, cx: &App) -> Option<(String, ProviderBanner)> {
        let composer = self.composer.read(cx);
        let instance = composer.selected_provider_instance()?;
        let banner = composer
            .catalog()
            .providers
            .iter()
            .find(|group| group.instance_id == instance)?
            .banner()?;
        let key = format!(
            "{}\u{0}{}",
            self.environment_key.as_deref().unwrap_or_default(),
            banner.key
        );
        (!self.dismissed_provider_banners.contains(&key)).then_some((key, banner))
    }

    fn dismiss_provider_banner(&mut self, key: String, cx: &mut Context<'_, Self>) {
        if self.dismissed_provider_banners.insert(key) {
            cx.notify();
        }
    }

    /// `Refresh`: probe the instance and bypass its model caches. The config stream brings the
    /// result; the button only waits for the call to end.
    fn refresh_provider_status(&mut self, instance_id: String, cx: &mut Context<'_, Self>) {
        let Some(connection) = self.connection.clone() else {
            return;
        };
        if self.provider_refreshing {
            return;
        }
        self.provider_refreshing = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let payload = conn_client::commands::refresh_providers_payload(
                conn_client::commands::ProviderRefresh::Instance(&instance_id),
            );
            let _ = connection
                .call::<_, serde_json::Value>("server.refreshProviders", &payload)
                .await;
            let _ = this.update(cx, |chat, cx| {
                chat.provider_refreshing = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// The banner element, pinned at the top of the chat.
    pub(super) fn render_provider_banner(&self, cx: &mut Context<'_, Self>) -> Option<AnyElement> {
        let (key, banner) = self.visible_provider_banner(cx)?;
        let tokens = &self.tokens;
        let accent = if banner.warning {
            tokens.warning
        } else {
            tokens.destructive
        };
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);
        let hover = hsla(tokens.shell_highlight);
        let link = hsla(tokens.primary);
        let refreshing = self.provider_refreshing;
        let instance_id = banner.instance_id.clone();
        let setup_instance = banner.instance_id.clone();
        let ax = |suffix: &str| format!("chat.provider-banner.{suffix}");

        let mut actions = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .justify_end()
            .gap(px(12.0));
        if banner.offers_setup {
            actions = actions.child(
                div()
                    .id("chat-provider-banner-setup")
                    .a11y_button(ax("open-setup"), "Open provider setup")
                    .px(px(4.0))
                    .rounded(px(4.0))
                    .text_size(px(12.0))
                    .line_height(px(20.0))
                    .text_color(link)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(ChatEvent::OpenProviderSetup(setup_instance.clone()));
                    }))
                    .child("Open provider setup"),
            );
        }
        let refresh_label: SharedString = if refreshing {
            "Refreshing...".into()
        } else {
            "Refresh".into()
        };
        actions = actions.child(
            div()
                .id("chat-provider-banner-refresh")
                .a11y_button(
                    ax("refresh"),
                    format!(
                        "Refresh {} status",
                        banner.title.trim_end_matches(" provider status")
                    ),
                )
                .flex()
                .items_center()
                .h(px(24.0))
                .px(px(8.0))
                .rounded(px(6.0))
                .border_1()
                .border_color(hsla_alpha(tokens.border, 0.8))
                .text_size(px(12.0))
                .text_color(fg)
                .when(refreshing, |el| el.opacity(0.5))
                .when(!refreshing, |el| {
                    el.cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .on_click(cx.listener(move |chat, _, _, cx| {
                            chat.refresh_provider_status(instance_id.clone(), cx);
                        }))
                })
                .child(refresh_label),
        );

        let body = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap(px(8.0))
            .child(
                div()
                    .text_size(px(13.0))
                    .line_height(px(20.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child(banner.title.clone()),
            )
            .child(
                div()
                    .text_size(px(13.0))
                    .line_height(px(20.0))
                    .line_clamp(3)
                    .text_color(fg)
                    .child(banner.message.clone()),
            )
            .children(banner.compatibility_note.clone().map(|note| {
                div()
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(muted)
                    .child(note)
            }))
            .child(actions);

        let dismiss_label = if banner.warning {
            "Dismiss provider warning"
        } else {
            "Dismiss provider error"
        };
        Some(
            div()
                .id("chat-provider-banner")
                .a11y_group(ax("banner"), banner.title)
                .flex()
                .flex_row()
                .items_start()
                .gap(px(10.0))
                .w_full()
                .max_w(px(BANNER_MAX_WIDTH_PX))
                .px(px(12.0))
                .py(px(10.0))
                .rounded(px(10.0))
                .bg(hsla_alpha(accent, 0.10))
                .border_1()
                .border_color(hsla_alpha(accent, 0.30))
                .child(icons::icon(icons::INFO, 15.0, hsla(accent)))
                .child(body)
                .child(
                    div()
                        .id("chat-provider-banner-dismiss")
                        .a11y_button(ax("dismiss"), dismiss_label)
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(20.0))
                        .flex_shrink_0()
                        .rounded(px(5.0))
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .on_click(cx.listener(move |chat, _, _, cx| {
                            chat.dismiss_provider_banner(key.clone(), cx);
                        }))
                        .child(icons::icon("superhero/close.svg", 12.0, muted)),
                )
                .into_any_element(),
        )
    }
}
