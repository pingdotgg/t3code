# VENT

Feedback log. Repeated/systemic workflow friction that should become future automation, docs, or workflow fixes.

## 26-10-01 16:39 — T3 optional MCP parameters block browser and PR-monitor workflows

The T3 direct MCP wrappers mark optional selectors as required nullable fields, but the handlers reject null. This repeated for pr_monitor_context/report (monitorId) and preview_status/preflight/open (tabId/url/target/show). Retrying with empty strings also failed minimum-length validation, and preview_open rejects tabId combined with reuseExistingTab=false, leaving no way to create the first tab. I worked around browser validation with local headless Playwright and used the supplied finding evidence, but could not attach the result to a collaborative browser or dispose the monitor finding. Prevention: make optional fields genuinely omittable in the exposed schemas, normalize null to undefined at the tool boundary, and provide a valid create-new-tab call shape plus a monitor selector by repo/PR/delivery.
