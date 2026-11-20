# conn-web

Embedded Chromium browser runtime (CEF-on-demand) for Conn's Browser panel and `html_render` surfaces.

- **Strategy:** Follow `.refs/threadbear/desktop/web/` (`cef` + `cef-dll-sys` with `features = ["dox"]`, `dlopen` loader in `src/mac/loader.rs`, `offscreen.rs`, `devtools.rs`, pinned CDN archive download on first use).
- **Important:** Do not block Phase 1–4 desktop builds on CEF; keep CEF loading lazy/on-demand.
