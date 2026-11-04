---
title: "Share a thread with guest links"
description: "Share a T3 Code thread with one guest, review their questions and attachments before they run, and understand link expiry and visibility."
updated: 2026-11-04
sources:
  - label: "Guest links, visibility, and attachments"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/guest-links.md"
  - label: "Guest access boundary"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md"
  - label: "T3 Connect setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md"
faq:
  - question: "Does a T3 Code guest need an account?"
    answer: "A T3 Code guest link opens one thread in a browser without an account. The link works in one browser and expires after 24 hours."
  - question: "Can a guest run commands through T3 Code?"
    answer: "T3 Code guests propose messages that wait for the owner to send or dismiss them. Once sent, a message and its files run with the thread's current permission mode."
  - question: "What can a T3 Code guest see?"
    answer: "A T3 Code guest sees recent thread history and subsequent streamed messages, files, replies, reasoning, plans, questions, and command output. Guests do not see diffs or gain general file-browsing access."
  - question: "How do I revoke a T3 Code guest link?"
    answer: "Choose Stop sharing in T3 Code. Archiving the thread, creating a replacement link, or unlinking the machine from T3 Connect also ends the link."
---

T3 Code guest links let one person follow a thread in their browser and propose messages without an account. Their messages wait for you to send or dismiss them before the agent runs anything. Guest links are a beta, require T3 Connect, and expire after 24 hours.

## Decide whether to share a thread

Use a guest link when a teammate needs to follow one conversation or provide information during the work. The guest sees the thread stream, including recent history. They do not receive a general environment login.

| Need                                                | Is a guest link suitable?                                          |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| Watch replies arrive and read command output        | Yes, within the shared thread                                      |
| Suggest a question with files for your review       | Yes, it waits for you                                              |
| Change the model or answer agent questions directly | No                                                                 |
| Browse your files, inspect diffs, fork, or revert   | No                                                                 |
| Connect your own phone to your environment          | Use the [mobile app](/learn/remote/mobile-apps) and normal pairing |

Check the existing conversation before sharing. A guest can see information the agent read or printed, including values from a file. The absence of file-browsing controls does not remove sensitive material already visible in the timeline.

## Enable sharing on the machine that owns the thread

Turn on `Settings → Labs → Guest links` for the machine running the thread. Sign in to T3 Connect and link that machine as well. The guest URL uses its T3 Connect address, and the host must stay online while the guest uses it.

This setting applies to the machine. Turning it off stops every guest link there. Turning it back on restores links that have not expired. Use `Stop sharing` when you want to end a specific share rather than pause the feature.

The [remote access guide](/learn/remote/remote-access) covers host setup. A working LAN or Tailscale connection alone does not supply the T3 Connect address that guest links need.

## Create and send one guest link

1. Right-click the thread in the sidebar and choose `Share with guest`.
2. Copy the resulting link and send it to one person.
3. Have that person open it in their browser.
4. Review their proposed messages as they arrive in the thread.

You can also start sharing from the thread menu or command palette. A link works in one browser. Reopening it there returns the guest to the thread until the link expires or sharing ends.

Creating another link ends the previous share. If the recipient needs continuing access after expiry, create a new link and send that replacement. Do not treat a guest link as permanent team access.

## Review a guest message before running it

A proposed message appears at the end of the thread, and the sidebar shows `Request`. Choose `Send` to run it as a normal turn, or `Dismiss` to decline it. Attached files appear with the message, and sending includes those files.

Check both the text and attachments before choosing `Send`. The accepted message uses the thread's current [permission mode](/learn/safety/permission-modes). Guest review decides whether the turn starts; it does not create a separate restricted agent mode for that message.

You can send or dismiss proposals from the [mobile app](/learn/remote/mobile-apps). This lets you review a guest's question while away from the desktop that hosts the work.

## Understand what the browser reveals

The guest sees your messages and the agent's replies as they stream, including attached files and images shown from your machine. Reasoning, plans, questions, and work appear in the same timeline. Expanded commands reveal their output.

The guest composer shows the model without allowing the guest to change it. Guests cannot fork or revert the thread, open arbitrary files on your machine, or answer the agent for you. Review the [thread workflow](/learn/threads/working-with-threads) if someone needs to understand how the conversation progresses.

## Handle guest attachments

Guests add files with the paperclip, paste, or drag and drop. Each message accepts up to four files totaling 10 MB. Images must be PNG, JPEG, GIF, or WebP.

Files attached to messages awaiting review can total 20 MB. Sending or dismissing some messages frees room for more pending attachments. A sent message retains its files as part of the thread.

Dismissing a message deletes its pending files. Ending the link or archiving the thread also deletes files belonging to messages that still await review. Decide whether to send a useful proposal before ending the share if its attachment needs to remain in the thread.

## End guest access

Choose `Stop sharing` to revoke the current link immediately. Archiving the thread, generating a replacement link, or unlinking the machine from T3 Connect also ends access. This differs from disabling the Labs setting, which pauses all guest links on the machine and allows unexpired links to resume when reenabled.

## Next steps

- Use [remote and mobile](/learn/remote) to compare guest sharing with your own remote access.
- Read [working with threads](/learn/threads/working-with-threads) before sharing a long-running conversation.
- Check the thread's [permission mode](/learn/safety/permission-modes) before accepting a guest request.
