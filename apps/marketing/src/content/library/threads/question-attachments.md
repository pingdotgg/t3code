---
title: "Attach files when an agent asks a question"
description: "Answer T3 Code agent questions with screenshots or files, keep each answer's uploads separate, and resolve upload failures before submitting."
updated: 2026-11-04
sources:
  - label: "Files in question answers"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/question-attachments.md"
  - label: "Composer attachment limits"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md"
  - label: "Activity log"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/activity-log.md"
faq:
  - question: "Can I attach a screenshot to an agent question in T3 Code?"
    answer: "Yes, when the T3 Code question accepts a custom answer. Use Attach files or paste an image into the answer field; mobile offers photos and files through its attachment button."
  - question: "Can I send a file without typing an answer?"
    answer: "T3 Code accepts a file by itself, with a selected option, or with a typed answer. The question must support a custom answer."
  - question: "Where do question attachments go?"
    answer: "T3 Code uploads question attachments to the environment running the thread. The agent receives paths to the saved files with your answer and can open them using its tools."
  - question: "Why is there no attachment button in my T3 Code question?"
    answer: "T3 Code questions restricted to predefined choices do not offer attachments. Older servers also need an update before the attachment option appears."
---

T3 Code lets you attach files or paste images when an agent's question accepts a custom answer. The attachments travel with that answer, stay separate from your normal prompt draft, and upload to the environment running the thread.

## Choose the answer field for the evidence

An agent may ask for more detail before it can continue. When that detail is a screenshot, sample input, or document, attach it to the question that asks for it. You can send the file alone, pair it with a selected option, or add a typed explanation.

For example, if the agent asks which layout is wrong, attach the screenshot to that answer and identify the affected part. If it asks for a sample file, supply that file rather than rewriting its contents from memory. These are suggested ways to answer; the question determines what evidence is useful.

Use the normal [message composer](/learn/threads/messages-and-context) for a new instruction outside the question. Keeping the evidence with its answer also lets you preserve an unrelated draft you were already preparing.

## Attach a file on web or desktop

1. Open the agent's question and check that it accepts a custom answer.
2. Choose **Attach files**, or paste an image into the answer field.
3. Add an explanation or select an offered option if useful.
4. Wait until all uploads finish.
5. Submit the answer.

Uploading is a separate step from submission. A file appearing in the answer does not mean its upload has finished. If an upload fails, retry it or remove it before submitting.

When there are several questions, each question keeps its own attachments as you move between them. Return to the relevant answer to check its files. Do not assume that a screenshot added to one question also belongs to another answer.

## Answer from a phone

On mobile, use the question's attachment button to choose photos or files. The same answer combinations apply: file only, file plus option, or file plus written text.

Before submitting, check that the selected image is the one the question needs. For an example response to a layout question, write which visible area is incorrect and what should change. A short explanation can distinguish an example to follow from an example of the bug.

The destination is still the environment running the thread. A phone attachment can therefore reach an agent on a remote machine. It does not stay available to that agent only on the phone.

## Check limits before adding a large set

You can attach up to 100 files across one set of answers. That is the set's total, so split the evidence deliberately among the questions instead of treating each question as a separate 100-file allowance.

Question answers use the normal composer's file and total image size limits:

| Attachment                    | Limit                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| Each image                    | Up to 10 MiB                                                       |
| Images in total               | Up to 80 MiB                                                       |
| Other files, including videos | Up to 50 MiB each, subject to environment upload support and limit |
| Files across the answer set   | Up to 100                                                          |

Provider and model limits still apply. The app's upload allowance does not guarantee a model can process every attachment together. For the broader attachment workflow, return to [messages and context](/learn/threads/messages-and-context).

## Understand what the agent receives

The agent receives saved file paths with your answer. It can open those files using its available tools. That path-based delivery matters when you are answering from a different device than the one running the work.

Do not assume every file type appears to the agent as an inline visual. If the answer relies on a particular detail, describe that detail in text as well. You can later inspect the [activity log](/learn/threads/activity-log) to see available tool inputs and results when the agent investigates your evidence.

Attaching a file supplies information. Agent permissions are a separate choice. See [permission modes](/learn/safety/permission-modes) for how T3 Code controls what the agent can do during the task.

## Recover when an answer will not send

| Symptom                 | What to check                                                  |
| ----------------------- | -------------------------------------------------------------- |
| No attachment control   | Does the question allow custom answers? Is the server current? |
| Submission waits        | Are uploads still running?                                     |
| A file failed to upload | Retry that upload or remove the file                           |
| The response failed     | The answer draft remains available for another attempt         |

Questions that accept only predefined choices cannot take attachments. Adding files through the normal composer does not change that question type. If the environment uses an older server, [update T3 Code](/learn/start/updating) before expecting the control to appear.

Submitted attachments remain in the thread history. Reverting the thread removes files belonging to discarded answers. Deleting the thread applies the same attachment cleanup used for other files, so keep your own copy when you need the original outside the conversation.

## Next steps

- Review how the agent used your answer in the [activity log](/learn/threads/activity-log).
- Use [messages and context](/learn/threads/messages-and-context) for attachments outside questions, or return to [threads and messages](/learn/threads) to choose another workflow.
