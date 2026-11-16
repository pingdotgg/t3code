# HTML publication parity

This part serves `html_render`, including its attachment. It installs or starts no browser.

| T3 boundary | Rust boundary | Proof |
| --- | --- | --- |
| HTML toolkit `html_render` handler, `pageSource`, `actsAsCaller` | `conn-mcp/src/tools/html.rs` | MCP test `html_render_publishes_for_live_callers_and_guards_file_access`; `tools/html-parity.mjs` calls T3's actual toolkit handler against our MCP transport |
| `HtmlRender.readPageFile` | `html::read_source` | `reads_html_documents_only_and_refuses_internal_links_and_hard_links`; parity file refusals and UTF-8 BOM |
| `HtmlRender.prepare`, `inlineLocalImages`, `rejectViewportHeight` | `html::prepare` | Rust tests for image bytes, missing order and CSS units; parity compares attachment bytes and exact failure messages |
| Shared `injectHtmlRenderBootstrap` | `inject_bootstrap` plus generated markup | Parity for heads, doctypes, scripts, comments, nested templates, textareas and plaintext; `gen-tools --check` holds the script and theme current |
| `HtmlRender.publish` | `html::publish` | Publication test; parity compares reference title, height and success message, ignoring only fresh attachment ids |
| Asset access and HTML CSP | Existing `Files` asset service and server asset route | Effect client's `assets.createUrl` decode and signed HTML GET |
| Client `htmlRenderFromToolItem` | Existing shared client parser | Each successful parity result is accepted by that parser |

The Rust tests extend these T3 `HtmlRender.test.ts` behaviors: inline absolute image paths,
leave relative and remote URLs alone, reject viewport-height CSS, validate SVG roots behind
processing instructions and doctype subsets, report all missing images, reject oversized
images and pages, restrict HTML file reads, and publish without a browser. No browser test
is required for this part: none of these operations launches one.

Preserved quirks: path input requires full access, but inline HTML works in plan mode and
approval-required mode. Image references inside JavaScript strings and backticks are inlined.
CSS-looking strings inside scripts are checked for viewport-height units. Missing images
are deduplicated in encounter order. Each successful call gets a fresh attachment id.

Known differences and limits:

- Optional measured heights are omitted. T3 measures only when its pinned browser is already
  installed, and falls back to this same reference when no browser exists or measurement fails.
- No provider-session fallback for a successful result that the provider omits from its
  transcript. Direct results retain the client contract's render reference.
- The scanner uses Rust's Unicode whitespace rules in HTML patterns.
  BOM file starts and JavaScript title trimming are covered explicitly. Other unusual
  Unicode syntax has no parity proof.
- Desktop and iPhone rendering have not been driven against this server. The proof covers
  the handler, shared client parser, client RPC decoder and signed asset delivery.

Remaining slice: pinned Linux browser install and host diagnostics, `html_preview`, the
14 server preview tools, preview client methods and events, viewer streaming, recordings, optional
height measurement, and provider-result recovery. T3 rejects `preview_cdp_endpoint` on server
tabs with "Not supported on server tabs: temporary CDP endpoints. Use a desktop tab."
That tool and the Electron relay methods stay out of scope.
