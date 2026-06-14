# ADR 001: Durable Renderer-Hosted Webview

## Status

Accepted with the failure-boundary amendment in `.plans/browser-phase-0-5/006-renderer-failure-boundary.md`.

## Decision

Keep Electron `<webview>` as the collaborative browser surface, but move it out of thread panel lifecycle into a route-durable app-level browser host. This does not survive host-renderer reload, renderer crash, owning-window close, or application restart.

The host owns one mounted webview per live browser tab. The visible browser panel supplies bounds and visibility intent. Hiding, switching routes, closing a sheet, or unmounting a panel must not remove the webview element or close its guest `WebContents`.

The desktop main process remains authoritative for navigation, CDP, recording, security policy, and guest `WebContents` validation. The renderer host is responsible only for maintaining the required DOM attachment and reporting presentation bounds.

## Hidden Presentation Policy

- Visible tab: place the webview at the panel bounds.
- Hidden idle tab: park it offscreen at its preserved viewport size; automation remains available but continuous screencast is not expected.
- Hidden recording tab: place it on a full-size in-window parking surface covered by an opaque application layer so Chromium continues producing compositor frames.
- Suspended tab: explicit lifecycle transition that may destroy and later reload the page; never perform silently while controlled or recording.

## Rejected Alternative

`WebContentsView` is not selected for this iteration. It is durable and Playwright-visible, but hidden/detached capture semantics failed the recording requirements and its native stacking model complicates overlays and clipping.
