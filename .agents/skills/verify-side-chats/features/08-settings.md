# Settings

Settings → Threads → Side chats controls the new-chat model, explanation instructions, and provider skills.

## Sub-features

- `settings-model` selects a side-chat model and options.
- `settings-explanation` edits side-chat instructions.
- `settings-skills` adds and removes skills.

## How to get to it (user POV)

- Open Settings, choose **Threads**, and scroll to **Side chats** (or use a side chat's **More side chat actions** → **Side chat settings**).
- Choose the model, edit instructions, and add a skill.

## Driving it with the Browser panel

Preconditions: the environment advertises side-chat settings and at least one provider/model.

- **Open.** `preview_navigate` the current origin route `/settings/threads`, then `preview_snapshot`; it shows a `Side chats` section.
- **Model.** `preview_click` `{role:"button", name:"Side chat model"}` and `preview_click` the desired `{role:"option", name:<model>}`. Snapshot shows the selected model; use `preview_wait_for` the settings save.
- **Explanation.** `preview_click` `{role:"textbox", name:"Side chat instructions"}`, `preview_type` `Use one concrete example`, then `preview_press` `Tab`. Snapshot retains the text after the blur save.
- **Skills.** `preview_click` `{role:"button", name:"Add a side chat skill"}`, `preview_click` `{role:"combobox", name:"Search or type a skill"}`, `preview_type` a listed skill, then `preview_click` its `{role:"option", name:<skill>}`. Snapshot shows a `$<skill>` badge and `{role:"button", name:"Remove <skill>"}`.

## Gotchas

- Older servers hide this section; record the capability mismatch rather than treating it as a UI failure.
- Skills attach at side-chat start only when the selected provider exposes them.
