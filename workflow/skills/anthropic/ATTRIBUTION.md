# Third-party skill attribution

`frontend-design` is vendored from Anthropic's `frontend-design` plugin (version 1.1.1) in the
`claude-plugins-official` marketplace, licensed under the Apache License 2.0. The license is kept
alongside this file as `LICENSE.anthropic`, and the skill's own copy as `frontend-design/LICENSE.txt`.

It used to be installed as the `frontend-design@claude-plugins-official` plugin, which only Claude
loads. It lives here so every provider T3 Code runs can use it; the plugin is uninstalled.

## Local modifications

- The process section gained one paragraph after the plan review: render the revised plan as a
  visual draft and get the client's approval before building, publishing it as a Claude Artifact
  when the Artifact tool is available and in the thread (`html_preview`, `html_render`) otherwise.

## Upstream sync

Synced against plugin version 1.1.1 (2026-11-17). To sync, diff the marketplace's
`plugins/frontend-design/skills/frontend-design` against this folder and reapply the change above.
