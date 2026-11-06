---
title: "Keybindings"
description: "Learn T3 Code keyboard defaults, rebind commands, configure composer shortcuts, and resolve conflicts with terminal, browser, and picker focus."
updated: 2026-11-04
sources:
  - label: "Keybindings and composer controls"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md"
  - label: "Default shortcut rules"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/keybindings.ts"
  - label: "Keyboard focus"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/keyboard-focus.md"
  - label: "Appearance shortcuts"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md"
  - label: "Usage shortcuts"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
  - label: "How I code without typing: background submission at 29:01"
    url: "https://www.youtube.com/watch?v=NvVbCqDgfCs&t=1741s"
faq:
  - question: "How do I change T3 Code keyboard shortcuts?"
    answer: "Open Settings → Keybindings on T3 Code web or desktop. That page lists the command IDs and defaults available in your installed version."
  - question: "Where is the T3 Code keybindings file?"
    answer: "T3 Code stores keybindings on the environment's machine, normally at ~/.t3/userdata/keybindings.json. The file contains an array of rules with key, command, and an optional when condition."
  - question: "What does mod mean in T3 Code shortcuts?"
    answer: "In T3 Code, mod means Command on macOS and Ctrl on Windows and Linux. These shortcuts run inside the focused web or desktop client."
  - question: "Why does my T3 Code shortcut work differently in the terminal?"
    answer: "Many T3 Code shortcuts exclude terminal focus so terminal input remains available. When multiple rules match, the last matching key and condition wins."
  - question: "How do I start a T3 Code thread in the background?"
    answer: "In a new T3 Code thread, mod+Enter sends the prompt in the background and opens a fresh composer. In an existing thread, mod+Alt+Enter sends and opens a new-thread composer."
---

T3 Code lets you change keyboard shortcuts in `Settings → Keybindings` on web and desktop. The page lists command IDs and defaults for your version, and the environment stores the rules in `keybindings.json`. A shortcut can depend on whether the composer, terminal, preview, or a picker has focus.

## Read the default shortcuts

`mod` means **Command on macOS** and **Ctrl on Windows and Linux**. The following tables describe default rules. Existing customizations can change the keys you see in Settings.

### Open pages and move around the workspace

| Action                             | Default                  | Context                                |
| ---------------------------------- | ------------------------ | -------------------------------------- |
| Command palette                    | `mod+K`                  | Outside the terminal                   |
| Next or previous workspace area    | `F6`, `Shift+F6`         | Visible workspace areas                |
| Browser-compatible area navigation | `mod+F6`, `mod+Shift+F6` | Use when the browser takes plain F6    |
| Toggle sidebar                     | `mod+B`                  | Focused client                         |
| Toggle right panel                 | `mod+Alt+B`              | Focused client                         |
| Toggle thread details              | `mod+Shift+B`            | Outside the terminal                   |
| Right-panel new-tab menu           | `mod+T`                  | Right panel open, outside the terminal |
| Back or forward                    | `mod+[`, `mod+]`         | Outside the terminal                   |
| File picker                        | `mod+P`                  | Outside the terminal                   |
| Project search                     | `mod+Shift+F`            | Outside the terminal                   |
| Open favorite editor               | `mod+O`                  | Focused client                         |
| Open Usage                         | `mod+U`                  | Outside the terminal                   |
| Theme picker                       | `mod+Alt+A`              | Outside the terminal                   |
| Cycle appearance mode              | `mod+Alt+Shift+A`        | Outside the terminal                   |
| Toggle theme editor                | `mod+Alt+Shift+T`        | Focused client                         |

### Control terminals, previews, and diffs

| Action                     | Default            | Context                                   |
| -------------------------- | ------------------ | ----------------------------------------- |
| Toggle terminal            | `mod+J`            | Focused client                            |
| Split terminal             | `mod+D`            | Terminal focused                          |
| Split terminal vertically  | `mod+Shift+D`      | Terminal focused                          |
| New terminal               | `mod+N`            | Terminal focused                          |
| Close terminal             | `mod+W`            | Terminal focused; browser may reserve it  |
| Close right-panel tab      | `mod+W`            | Outside terminal; browser may reserve it  |
| Reopen last closed app tab | `mod+Shift+T`      | Browser may reserve it                    |
| Toggle diff                | `mod+D`            | Outside terminal                          |
| Toggle preview             | `mod+Shift+J`      | Focused client                            |
| Refresh preview            | `mod+R`            | Preview focused                           |
| Focus preview URL          | `mod+L`            | Preview focused                           |
| Zoom preview in            | `mod+=` or `mod++` | Preview focused                           |
| Zoom preview out           | `mod+-`            | Preview focused                           |
| Reset preview zoom         | `mod+0`            | Preview focused                           |
| Find in diff               | `mod+F`            | Click into a diff first; not configurable |

Diff find covers folded files and hidden unchanged lines. Very large uncommitted diffs load files as you scroll, so search covers the files loaded so far.

### Start and manage threads

| Action                             | Default                      | Context                                               |
| ---------------------------------- | ---------------------------- | ----------------------------------------------------- |
| New thread                         | `mod+N` or `mod+Shift+O`     | Outside terminal; may show project chooser            |
| New thread without project chooser | `mod+Shift+N`                | Outside terminal                                      |
| New thread without a project       | `mod+Alt+N`                  | Outside terminal                                      |
| Previous or next thread            | `mod+Shift+[`, `mod+Shift+]` | Focused client                                        |
| Jump to thread 1–9                 | `mod+1` through `mod+9`      | Desktop, model picker closed                          |
| Find in current thread             | `mod+F`                      | Outside terminal and preview                          |
| Copy thread or selected PR link    | `mod+Shift+C`                | Outside terminal                                      |
| Copy selected PR number            | `mod+Shift+K`                | Outside terminal                                      |
| Settle thread                      | `mod+Shift+S`                | Outside terminal                                      |
| Pin thread                         | `mod+Shift+P`                | Outside terminal                                      |
| Undo sidebar action                | `mod+Z`                      | Outside terminal; see temporary notice behavior below |
| Stash composer                     | `mod+S`                      | Outside terminal                                      |
| Edit queued message                | `Alt+Up`                     | Composer focused                                      |
| Send first queued message          | `mod+Shift+Enter`            | Outside terminal                                      |

### Choose the model and control submission

| Action                         | Default                          | Context                    |
| ------------------------------ | -------------------------------- | -------------------------- |
| Model picker                   | `mod+Shift+M`                    | Outside terminal           |
| Host picker                    | `mod+Shift+H`                    | Outside terminal           |
| Effort picker                  | `mod+Shift+E`                    | Outside terminal           |
| Permissions picker             | `mod+Shift+A`                    | Outside terminal           |
| Workspace picker               | `mod+Shift+X`                    | Outside terminal           |
| Branch picker                  | `mod+Shift+G`                    | Outside terminal           |
| Reuse previous worktree        | `mod+Shift+L`                    | Outside terminal           |
| Previous or next provider      | `mod+Shift+Up`, `mod+Shift+Down` | Model picker open          |
| Choose model 1–9               | `mod+1` through `mod+9`          | Desktop, model picker open |
| Insert newline                 | `Shift+Enter`                    | Composer                   |
| Opposite Queue or Steer action | `mod+Enter`                      | Composer, turn running     |
| Start in background            | `mod+Enter` or `mod+Alt+Enter`   | New-thread composer        |
| Send and start new thread      | `mod+Alt+Enter`                  | Existing-thread composer   |

**Composer: Cycle Host**, **Composer: Increase Effort**, **Composer: Decrease Effort**, and `thread.stop` have no default shortcut. Bind them in Settings if you need direct access. Effort stepping wraps at either end of the available levels.

### Navigate Usage and quit the desktop app

| Action                           | Default                              | Context                    |
| -------------------------------- | ------------------------------------ | -------------------------- |
| Cost, Tokens, or Limits          | `C`, `T`, `L`                        | Usage, outside text fields |
| Past 24 hours, 7, 30, or 90 days | `mod+Shift+1/2/3/4`                  | Usage; no effect on Limits |
| Return from Usage                | `Escape`                             | Usage                      |
| Quit desktop app                 | `Cmd+Q` on macOS; `Ctrl+Q` elsewhere | Default Hold confirmation  |

In default **Hold** mode, hold the quit shortcut for 1.2 seconds or press twice within 500 milliseconds. Change `Settings → General → Confirmations → Quit shortcut` to **Direct** or **Double press** if preferred. The application menu's Quit command quits immediately.

## Rebind a command without changing its scope

1. Open `Settings → Keybindings` on web or desktop.
2. Find the command by its name or ID.
3. Choose keys that your operating system and browser leave available.
4. Keep any focus condition you still need.
5. Try the binding in the composer and terminal to confirm its intended scope.

Many defaults contain `!terminalFocus`. Keep that condition if you want terminal input protected. For a shortcut that runs in the wrong panel, inspect [keyboard focus](/learn/customize/keyboard-focus) before assigning more keys.

You can also edit `~/.t3/userdata/keybindings.json` on the environment's machine:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

Each rule needs `key` and `command`. Optional `when` conditions combine context keys with `!`, `&&`, `||`, and parentheses. Examples include `composerFocus`, `terminalOpen`, `previewFocus`, `modelPickerOpen`, `draftThreadRoute`, `turnRunning`, `editableFocus`, `isWeb`, and `isDesktop`. Unknown context keys evaluate to false.

The last matching rule wins, even across different commands. Place a specific rule after a general rule when they share keys. T3 Code ignores invalid rules and falls back to defaults when the file cannot be parsed. New defaults are added on later startups without replacing customized commands.

## Choose Enter behavior and background submission

In `Settings → Chat → Send shortcut`, choose Enter submission, modifier submission for multiline prompts, or modifier submission for every prompt. This affects the web and desktop composer at desktop widths. `Shift+Enter` inserts a newline.

**Follow-up behavior** selects Queue or Steer while an agent runs. `mod+Enter` performs the opposite action for one message, even when your send preference already requires a modifier. The alternate-action and background bindings take priority over the send shortcut. The send button uses the configured follow-up behavior.

For a new draft, `mod+Enter` starts work and leaves you in a fresh composer. Theo demonstrates this at 29:01 in [How I code without typing](/learn/videos/code-without-typing). Use it when you have several prompts ready and want to start the next one without reopening the composer.

## Resolve browser and terminal conflicts

Desktop `mod+W` closes a terminal or active right-panel tab and never closes the window. A browser uses it to close its browser tab. Rebind `terminal.close` and `rightPanel.close`, for example to `Alt+W`, for browser use.

Browsers can also take `mod+Shift+T` before T3 Code can reopen an app tab. That app command restores closed file, diff, PR, browser, and device tabs in closure order. A reopened browser starts a fresh session, and reopening a tab does not restore deleted work.

Desktop number shortcuts switch threads or select models according to picker state. Their default `isDesktop` condition leaves browser tab switching intact. Remove that condition only if you want the same behavior in a browser.

Sidebar undo has a temporary exception to text-field behavior. Immediately after an eligible sidebar action, `mod+Z` can undo it from the composer. Typing or pressing another key returns undo to the field. Terminals keep native undo behavior.

## Use an iPad hardware keyboard

With an iPad hardware keyboard, the defaults are:

| Action                                      | Default                 |
| ------------------------------------------- | ----------------------- |
| Open displayed thread 1–9                   | `Cmd+1` through `Cmd+9` |
| Open or close command palette               | `Cmd+K`                 |
| Close palette                               | `Escape`                |
| Navigate palette and select                 | Arrow keys, then Return |
| Select palette result directly              | `Cmd+1` through `Cmd+9` |
| Restrict palette to actions                 | Start search with `>`   |
| Move a new-thread draft to the next machine | `Cmd+Shift+H`           |
| Send from composer                          | Return or `Cmd+Return`  |
| Insert newline                              | `Shift+Return`          |

Thread jumps follow the current list filters and order. Change Return behavior in `Settings → Keyboard` if you prefer newline insertion.

## Next steps

[Practice workspace focus](/learn/customize/keyboard-focus) and [bind appearance controls](/learn/customize/appearance).
Read [usage and limits](/learn/customize/usage-and-limits) for the Usage view's filters and readings.
Share script definitions through [t3.json](/learn/customize/t3-project-file), then use `script.{id}.run` for project-script bindings.
Return to [settings and customization](/learn/customize) for the full settings map.
