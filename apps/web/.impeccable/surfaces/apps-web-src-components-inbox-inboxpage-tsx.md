---
version: 1
slug: "apps-web-src-components-inbox-inboxpage-tsx"
primary_target: "apps/web/src/components/inbox/InboxPage.tsx"
related_targets: ["apps/web/src/components/reports/ReportHeader.tsx"]
---

Scope: the PostHog report surfaces — the inbox list (`/inbox`, `/done`), its triage focus state, and the report detail route (`/inbox/$reportId`). Visitor mode: Operate.

Audience and job: a PostHog engineer in one of two phases — flipping a queue of 10–30 reports, or having chosen one to take seriously. The surface's only job is producing a decision, and making the "yes" run on the user's own subscription without leaving the report.

Direction (pinned by the maintainer, beats the roll): the composition from PostHog's desktop inbox — a report document that owns the page, a resizable conversation dock that expands to the full workspace and collapses back, and a keyboard-driven triage card that is a focus state of the list rather than a route. Inherited deliberately, including humanized report titles (a report reads as a brief, not a commit) and labeled summary slots.

Memorable moment: every judgment on the page can be interrogated. Priority, the verified tick, each suggested reviewer, the chosen repository — each is a claim an agent made, and each carries that agent's own sentence justifying it, one hover away. All of it is already in the API response and discarded by both PostHog surfaces today.

Structure:

- List — sections with counts, Graphite-style: predefined (For you, Needs a decision, In flight, Watching) plus user-defined sections the reader names and filters. Rows read as two-line objects at a readable measure, never fixed-width columns across the full viewport.
- Triage — a focus state of the list (`t` to enter, `esc` to leave), walking the decision queue only, showing the lede and slots so a report can be ruled on without opening it. Engaging advances to the next report rather than ending the pass.
- Detail — the document, with the verdict rendered as a lead line carrying real verbs (Implement · Answer · Defer · Archive) chosen by the report's actionability. Argument open, proof folded. Dock open collapses the page to one column.

Deliberately not surfaced: the priority judgment's `dollar_value`. PostHog computes it but defines it nowhere, and an undefined figure on a decision screen is noise.

Unresolved: custom sections persist in server settings (one PostHog key per server makes that effectively per-user, and it reaches remote clients for free). Defer/snooze ships disabled with its reason in the tooltip until the set-state RPC accepts a dismissal reason.
