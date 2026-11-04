---
title: "Messages, files, and context"
description: "Give T3 Code files, images, quoted replies, and thread references, then choose whether follow-up messages queue or steer the running agent."
updated: 2026-11-04
sources:
  - label: "Messages and context"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Composer context references"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/composer-context-references.md"
  - label: "Files in question answers"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/question-attachments.md"
  - label: "Theo on image context"
    url: "https://www.youtube.com/watch?v=xJaMTo2YgO8&t=960s"
faq:
  - question: "How many files can I attach to a T3 Code message?"
    answer: "T3 Code accepts up to 100 files per message. Each image can be up to 10 MiB, with 80 MiB of images total; other files can be up to 50 MiB each, subject to environment upload support and limits."
  - question: "Does attaching another thread copy its whole conversation?"
    answer: "A same-server thread chip in T3 Code carries a reference that the agent can read on demand. Dropping a thread from an environment outside the linked-machine reference path attaches a saved transcript instead."
  - question: "Why did T3 Code turn my pasted text into a file?"
    answer: "T3 Code makes a text attachment when you paste 32 KiB or more, or when a smaller paste would exceed the message limit. Use Cmd+Shift+V on Apple hardware keyboards or Ctrl+Shift+V elsewhere to keep the paste editable."
  - question: "Can I change instructions while an agent is working?"
    answer: "T3 Code supports Queue and Steer follow-up actions, with steering available when the running agent supports it. Choose your default in Settings \u2192 Chat \u2192 Follow-up behavior on web and desktop, or Settings \u2192 Chat on mobile."
---

T3 Code lets you combine instructions with files, images, quoted replies, and context references inside the composer. Context chips sit where your cursor is, so you can explain each piece of evidence beside the request it supports.

## Attach a file or screenshot to a message

1. Open the thread's composer and write the task.
2. Put the cursor beside the instruction the context should explain.
3. Attach the supporting files, or drag or paste an image on web or desktop.
4. Wait for every upload to finish.
5. Retry or remove failed uploads, then send.

Uploads start as soon as you add an attachment. Reloading web or desktop before an upload completes means attaching that file again. The files go to the environment running the thread, including when you connect to a remote machine.

You can attach up to 100 files per message. Each image can be up to 10 MiB, and one message can contain at most 80 MiB of images. Other files, including videos, can be up to 50 MiB each, subject to environment upload support and limits. The provider and model can impose additional limits.

A video attachment generally gives the agent a file path. Only the Antigravity integration sends supported videos to Gemini models as video. Avoid assuming every provider sees the same attachment in the same way.

For a request inside an agent's question, use [question attachments](/learn/threads/question-attachments) instead of placing the file in an unrelated follow-up message.

## Put context beside the instruction it explains

A chip can represent a file, image, terminal excerpt, review comment, picked page element, or preview annotation. Type before and after it. Cut and paste it to move the reference, or delete it like a character.

For example, attach a failing command's terminal excerpt beside the request to investigate it. Put a screenshot beside the description of the layout you want changed. This gives the agent an explicit connection between evidence and task.

Images also remain in the thumbnail shelf above the text. Deleting an image chip leaves its thumbnail. Removing a thumbnail that the text still references asks first, then removes both. Files exist only as chips, so deleting the final chip for a file removes it from the message.

Hover a chip for brief details. Select a terminal excerpt or review comment for its captured content. On mobile, tap to inspect. File references open the current file; attached files show the copy attached to the message.

Use the [activity log](/learn/threads/activity-log) when you need to locate the command result that should support your next instruction.

## Reference another thread or pull request

Type `@` and part of a thread title to select a thread on the same server. Linked machines also appear while the Linked environments beta is enabled. On web and desktop, you can drag threads from the sidebar into the composer. **Copy thread** produces a link that pastes as a chip on any client.

The reference lets the agent retrieve history on demand. Attaching a long thread does not load its full history into the prompt immediately. It does not modify that thread or authorize the agent to send messages there.

A reference to a linked machine is read on that machine. A pasted thread link from another machine outside that path remains a link. Dropping a thread from another environment attaches a saved transcript file instead. The source must be connected and up to date when you drop it.

That transcript captures visible history and saved text context at the time of the drop. It excludes later messages and attached file contents. The saved transcript remains readable after the source disconnects. For continuing with another provider in the same conversation, read [portable handoffs](/learn/threads/portable-handoffs).

On web and desktop, type `#` to find pull requests in the current repository. Enter digits for a number or a word for a text search. Linked pull requests appear too. The chip captures the title, branches, and state at attachment time; select it to inspect those details or open the pull request.

## Quote an answer or reuse a prompt

On web and desktop, select text in one assistant response and choose **Cite in composer**. Add a comment that tells the agent what to reconsider or preserve. The quote and comment count toward the message limit, and the saved quote stays readable if its source changes.

Press `ArrowUp` in an empty composer to recall a sent prompt's text. Recall does not restore its attachments or terminal context. To keep a draft with its attachments, wait for uploads and use `Cmd+S` or `Ctrl+S` to stash it. Uploaded stash files remain available for 24 hours and must be restored in their original environment.

Messages allow up to 120,000 characters. A paste of 32 KiB or more becomes a text attachment. Use `Cmd+Shift+V` on Apple hardware keyboards or `Ctrl+Shift+V` elsewhere to retain editable text. Read [prompt links](/learn/threads/prompt-links) when you want to share a prepared request.

## Queue a follow-up or steer current work

| Choose    | Intended timing                                       |
| --------- | ----------------------------------------------------- |
| **Queue** | Save the message for a later turn                     |
| **Steer** | Give the running turn new instructions when supported |

Set the default in `Settings → Chat → Follow-up behavior` on web and desktop. Mobile exposes the choice under `Settings → Chat`. Queued messages remain saved on the server and can be edited or removed.

On mobile, the send button states its current action. Long-press for the alternative. On web and desktop, the alternate shortcut depends on your configured send shortcut. When Enter sends, `Cmd+Enter` or `Ctrl+Enter` uses the opposite follow-up action.

Stopping the agent or restarting the server holds the queue in order. Use **Resume** in an empty composer to continue. Sending a new message also resumes the queue, unless it steers a turn that is already running. Editing or removing held messages does not start them.

## Next steps

- Choose a workspace and organize work with the [thread workflow](/learn/threads/working-with-threads).
- Add supporting material to an answer with [question attachments](/learn/threads/question-attachments), or review [permission modes](/learn/safety/permission-modes) before granting broader access.
- Return to [threads and messages](/learn/threads) for the full conversation guide list.
