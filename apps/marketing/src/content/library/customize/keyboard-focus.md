---
title: "Keyboard focus"
description: "Move through T3 Code threads, composer, panels, and Settings with the keyboard, and understand where focus returns after menus and pickers close."
updated: 2026-11-04
sources:
  - label: "Keyboard focus"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/keyboard-focus.md"
  - label: "Shortcut conditions and precedence"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md"
  - label: "Usage keyboard navigation"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
  - label: "Mobile voice input"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Android voice transcription"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/native/voiceTranscription.android.ts"
  - label: "How I code with AI changed a lot: dictated prompts at 21:00"
    url: "https://www.youtube.com/watch?v=xJaMTo2YgO8&t=1260s"
faq:
  - question: "How do I move between T3 Code panels with the keyboard?"
    answer: "On T3 Code web and desktop, F6 and Shift+F6 move between visible workspace areas. Use mod+F6 and mod+Shift+F6 if your browser reserves plain F6 for its toolbar."
  - question: "Where does focus go when I close the T3 Code command palette?"
    answer: "T3 Code returns focus to the composer in chat or to the previous control on other pages. Choosing a workspace focus command moves to that area instead."
  - question: "Can I browse T3 Code threads without opening each one?"
    answer: "Yes. In the T3 Code thread list, Up and Down move focus without opening a thread. Enter opens the focused thread, and F2 renames it."
  - question: "Why do number shortcuts select a model instead of a thread?"
    answer: "T3 Code routes number shortcuts to entries while the command palette or model picker is open. The picker keeps those keys until it closes."
---

T3 Code uses `F6` and `Shift+F6` to move between visible workspace areas on web and desktop. Navigation wraps around, skips hidden areas, and restores the last focused control in each area. In browsers that reserve plain `F6`, use `mod+F6` and `mod+Shift+F6`.

## Move from the composer to another workspace area

Area navigation covers the Threads sidebar, conversation, message input, and visible panels. It moves between those areas without requiring you to tab through every control in the page.

1. Start in the composer or another workspace area.
2. Press `F6` to move forward, or `Shift+F6` to move backward.
3. Repeat until the area you want has focus.
4. Use that area's controls to complete your task.
5. Use area navigation again to return to the message input.

`mod` is Command on macOS and Ctrl on Windows and Linux. If a browser moves focus to its toolbar, switch to the modifier versions. **Focus Next Workspace Area** and **Focus Previous Workspace Area** also appear in the command palette. Rebind them in `Settings → Keybindings` if another combination suits your keyboard.

An area must be visible to receive focus through this route. Open the terminal or right panel before trying to reach it. The [keybindings guide](/learn/customize/keybindings) lists the panel toggles and explains their conditions.

## Navigate the thread list without changing the open thread

Moving focus and opening a thread are separate operations. This lets you inspect where you are in the list before changing the conversation on screen.

| Task                                          | Key                             |
| --------------------------------------------- | ------------------------------- |
| Move between threads and their buttons        | `Tab`                           |
| Move between thread rows without opening them | `Up`, `Down`                    |
| Open the focused thread or toggle a group     | `Enter`                         |
| Expand or collapse a group                    | `Right`, `Left`                 |
| Rename the focused thread                     | `F2`                            |
| Open the focused thread's context menu        | `Shift+F10` or Context Menu key |
| Choose a menu item                            | Arrow keys, then `Enter`        |
| Close the menu                                | `Escape`                        |

Use Up and Down when you want to browse rows while keeping the current conversation visible. Press Enter when you reach the thread you want. See [working with threads](/learn/threads/working-with-threads) for the thread workflow around these controls.

A workspace area command closes a thread context menu when focus moves away. Other dialogs and form popups retain focus, so a form stays contained while it is open.

## Understand palette and model-picker focus

The command palette holds focus while open. Closing it returns focus to the composer in chat, or the previous control on another page. Selecting a workspace focus command moves directly to that area. Opening Pull Requests from the palette focuses that page instead.

While the palette or model picker is open, number shortcuts select entries instead of switching threads. Model shortcuts work in Settings as well as in the composer. A number selecting a model is therefore expected when the picker is open.

In the model picker, Left from an empty search field or `Shift+Tab` reaches the provider list. Up and Down move through providers; Enter chooses one. Right returns to model search. At the search field's end, Right moves to the highlighted model's effort levels, and Left returns.

These routes let you choose a provider, model, and effort without repeatedly closing and reopening the picker. Choosing a model keeps the picker open on its effort selection.

## Keep typing when a terminal finishes starting

If you return to typing while a terminal starts, the composer keeps focus when the terminal becomes ready. Explicitly opening or switching to a terminal still focuses it.

This distinction matters when a shortcut appears to produce a different result. `mod+D` splits a focused terminal, while the same keys outside the terminal toggle the diff. Several other defaults exclude terminal focus to preserve normal terminal input. Read [terminal history](/learn/workspace/terminal) when your next task is inside the terminal itself.

Check the active area before rebinding a working shortcut. A condition that protects terminal input may be the reason it does not run from that area.

## Move through Settings and Usage

In Settings, `F6` switches between the section list and the open section. Up and Down move through section choices; Enter opens one. You can use that route to reach [Appearance](/learn/customize/appearance) without using the mouse.

On [Usage](/learn/customize/usage-and-limits), `C`, `T`, and `L` choose Cost, Tokens, and Limits while you are outside a text field. Escape returns to the previous page. Use the modified number shortcuts for history periods; period selection has no effect on Limits.

## Combine navigation with dictated prompts

In _How I code with AI changed a lot_, Theo describes using voice-to-text to write a long initial prompt at 21:00. Treat dictation and focus as separate tasks: first choose the input, then review the resulting text before submission.

T3 Code supports mobile voice input on compatible iPhones with iOS 26 or later and Android devices with Android 12 or later. Use the composer microphone to record, then confirm transcription. Review and edit the draft before sending it. If the microphone button is absent, check `Settings → Microphone` for device or language availability. Keep T3 Code open on Android while recording and transcribing.

## Next steps

[Rebind navigation commands](/learn/customize/keybindings) after trying the defaults in each area.
Set [appearance preferences](/learn/customize/appearance) and inspect [Usage](/learn/customize/usage-and-limits) with the same focus controls.
Return to [settings and customization](/learn/customize) for project defaults and repository configuration.
