# Settings

Settings → Threads → Side chats controls the new-chat model, explanation instructions, and provider skills.

## Sub-features

- `settings-model` selects a side-chat model and options.
- `settings-explanation` edits side-chat instructions.
- `settings-skills` adds and removes skills.

## How to get to it (user POV)

- Open Settings, choose **Threads**, and scroll to **Side chats** .
- Choose the model, edit instructions, and add a skill.

## Driving it with the Browser panel

Preconditions: none beyond Doctor.

- **Open.** `preview_navigate` to `/settings/threads` on the app origin. The page has a `Side chats` section with `Model for new side chats`, `How side chats explain things` and `Side chat skills`.
- **Model.** `preview_click` `role=button[name='Side chat model']`, `preview_type` the model into `[placeholder='Search models...']`, then `preview_click` `role=option[name=/<model>/]`. Reload: the button still shows the model.
- **Explanation.** `preview_type` into `role=textbox[name='Side chat instructions']`, then `preview_press` `Tab`. Reload: the text is still there.
- **Skills.** `preview_click` `role=combobox[name='Add a side chat skill']`, type a listed skill and choose it. A `$<skill>` badge appears with `role=button[name='Remove <skill>']`.
- **Restore.** Put every value back (QA's model is `Showcase`; reset instructions; `Reset side chat skills to default`).

## Gotchas

- An older server hides this section. Record that as a version mismatch, not as a UI failure.
- Skills attach at side-chat start only when the provider has them.
