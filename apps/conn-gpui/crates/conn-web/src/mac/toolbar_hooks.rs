//! Reads the Laravel Toolbar's response headers natively, as Conn's main process does
//! (`apps/desktop/src/preview/ResponseHeaderRelay.ts`).
//!
//! A page with a Content-Security-Policy gets no inline toolbar data, but every response of a
//! Laravel app carries it in `x-toolbar` / `x-toolbar-summary` headers. CEF hands the browser
//! process each document and fetch/XHR response (`on_resource_response`), headers included, so
//! the host sees them without running any script in the page.

use std::os::raw::c_int;
use std::sync::{Arc, Mutex};

use cef::*;

use crate::ToolbarResponse;

pub(crate) type ToolbarResponseCallback = Arc<dyn Fn(ToolbarResponse) + Send + Sync>;
pub(crate) type ToolbarResponseSlot = Arc<Mutex<Option<ToolbarResponseCallback>>>;

fn header(response: &mut Response, name: &str) -> Option<String> {
    let value = CefString::from(&response.header_by_name(Some(&CefString::from(name)))).to_string();
    (!value.trim().is_empty()).then_some(value)
}

wrap_resource_request_handler! {
    struct ToolbarResourceHandler {
        slot: ToolbarResponseSlot,
        document: bool,
    }

    impl ResourceRequestHandler {
        // CEF's default for this method is `ReturnValue::CANCEL` (the zero value), which would
        // abort every request this handler is attached to. Let each one go ahead.
        fn on_before_resource_load(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _request: Option<&mut Request>,
            _callback: Option<&mut Callback>,
        ) -> ReturnValue {
            ReturnValue::CONTINUE
        }

        fn on_resource_response(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            request: Option<&mut Request>,
            response: Option<&mut Response>,
        ) -> c_int {
            let (Some(request), Some(response)) = (request, response) else {
                return 0;
            };
            let full = header(response, "x-toolbar");
            let summary = header(response, "x-toolbar-summary");
            // The page's own request has no toolbar headers: nothing to say.
            if full.is_none() && summary.is_none() && !self.document {
                return 0;
            }
            let callback = self.slot.lock().ok().and_then(|slot| slot.clone());
            if let Some(callback) = callback {
                callback(ToolbarResponse {
                    document: self.document,
                    method: CefString::from(&request.method()).to_string(),
                    url: CefString::from(&request.url()).to_string(),
                    full,
                    summary,
                });
            }
            0
        }
    }
}

wrap_request_handler! {
    pub(crate) struct ToolbarRequestHandler {
        slot: ToolbarResponseSlot,
    }

    impl RequestHandler {
        // Logged for `CONN_WEB_TRACE`: every navigation the browser process is about to start.
        fn on_before_browse(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            request: Option<&mut Request>,
            user_gesture: c_int,
            is_redirect: c_int,
        ) -> c_int {
            if frame.is_some_and(|f| f.is_main() == 1)
                && let Some(request) = request
            {
                super::view::trace(&format!(
                    "on_before_browse {} gesture={user_gesture} redirect={is_redirect}",
                    CefString::from(&request.url())
                ));
            }
            0
        }

        // A crashed or killed renderer ends every load that was waiting on it.
        fn on_render_process_terminated(
            &self,
            _browser: Option<&mut Browser>,
            status: TerminationStatus,
            error_code: c_int,
            error_string: Option<&CefString>,
        ) {
            super::view::trace(&format!(
                "on_render_process_terminated status={status:?} code={error_code} text={:?}",
                error_string.map(ToString::to_string).unwrap_or_default()
            ));
        }

        fn resource_request_handler(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            request: Option<&mut Request>,
            _is_navigation: c_int,
            _is_download: c_int,
            _request_initiator: Option<&CefString>,
            _disable_default_handling: Option<&mut c_int>,
        ) -> Option<ResourceRequestHandler> {
            // Only documents and fetch/XHR carry the toolbar: images, scripts and the rest
            // never reach the handler.
            let kind = request?.resource_type();
            let document = kind == ResourceType::MAIN_FRAME;
            (document || kind == ResourceType::XHR)
                .then(|| ToolbarResourceHandler::new(self.slot.clone(), document))
        }
    }
}
