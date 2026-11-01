# Reference screenshots

The "quality versus Codex and Claude" axis compares T3 Code with the Codex and Claude iOS apps. Their App Store builds do not run on a simulator, so a maintainer captures these on a real device and saves them here. Every PNG or JPEG in this folder goes into the next pack, under `references/`.

Do not scrape or commit third-party marketing images. Use your own screenshots of the apps, with your own test account and no personal data in view.

Name each file `<app>-<device>-<screen>.png`, for example `codex-iphone-thread.png`. Capture each app in dark mode, at the default text size:

| Screen                                                    | iPhone                          | iPad                     |
| --------------------------------------------------------- | ------------------------------- | ------------------------ |
| Conversation list                                         | `<app>-iphone-threads.png`      | `<app>-ipad-threads.png` |
| A conversation with tool calls or code                    | `<app>-iphone-thread.png`       | `<app>-ipad-thread.png`  |
| The agent still writing its reply                         | `<app>-iphone-streaming.png`    |                          |
| Composer with the keyboard up                             | `<app>-iphone-composer.png`     |                          |
| Model picker open                                         | `<app>-iphone-model-picker.png` |                          |
| New conversation or task                                  | `<app>-iphone-new.png`          | `<app>-ipad-new.png`     |
| A question or approval from the agent, if the app has one | `<app>-iphone-question.png`     |                          |
| A diff or code review view, if the app has one            | `<app>-iphone-diff.png`         | `<app>-ipad-diff.png`    |
| Settings                                                  | `<app>-iphone-settings.png`     |                          |

`<app>` is `codex` or `claude`. Skip a screen the app does not have.
