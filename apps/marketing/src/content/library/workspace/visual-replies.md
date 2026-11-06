---
title: "Visual replies and HTML renders"
description: "Ask T3 Code agents for HTML charts, diagrams, mockups, and screenshot comparisons that render inside your thread on every client."
updated: 2026-11-04
sources:
  - label: "Visual replies and MCP apps"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/html-renders.md"
  - label: "Import browser sessions"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/browser-import.md"
  - label: "SnapShots"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/snap-shot.md"
  - label: "Theo's annotated UI comparison, 11:00"
    url: "https://www.youtube.com/watch?v=xq0eB8vxeqk&t=660s"
faq:
  - question: "How do I get an HTML preview in a T3 Code reply?"
    answer: "Ask a T3 Code agent for a visual answer, such as a chart, diagram, or mockup. The agent creates a self-contained HTML page that appears above its written reply."
  - question: "Do visual replies work with every T3 Code provider?"
    answer: "T3 Code visual replies work with every provider on web, desktop, and mobile. MCP Apps have separate provider support: the documented support is Codex."
  - question: "Can T3 Code visual replies use local images?"
    answer: "T3 Code embeds local images referenced by file path when the page is published. The visual reply keeps working if those original files later move or are deleted."
  - question: "Does deleting a thread delete its HTML renders?"
    answer: "Deleting a T3 Code thread deletes its visual reply pages. Keep the thread if you still need to return to those pages."
---

T3 Code agents can answer with a self-contained HTML page that appears inside the thread above their written reply. Ask for a chart, diagram, mockup, table, or image comparison when a visual answer helps you understand the result.

## Ask for the visual you need

Describe the decision the visual should support. A request for a before-and-after comparison is more useful when it also identifies what you need to compare: spacing, typography, information hierarchy, or a particular interaction.

Example requests include:

- Show these measurements as a chart and label the units.
- Make a collage of these screenshots with notes beside the changed areas.
- Draw a diagram showing how these components exchange data.
- Create an HTML mockup so I can compare the two proposed layouts.

These are example prompts, rather than built-in templates. The agent builds the HTML response for your request. Give it source data or screenshots when you need the visual to represent existing work accurately.

Visual replies work with every provider on web, desktop, and mobile. You do not need to switch agents to ask for one. For a walkthrough of screenshot-based design feedback, see [Agents sucked at UI](/learn/videos/agents-sucked-at-ui). Theo's demonstration includes annotated comparisons that make small design changes easier to inspect.

## Read and interact with the rendered page

The page follows your current T3 Code theme, including custom themes. It also follows light and dark mode as you switch. Expand it to use the full screen. On web and desktop, zoom controls let you inspect details.

Scripts can run inside the page. T3 Code sandboxes the page away from the app and your session. Links you select open in your browser.

Use that distinction when evaluating a result. An interactive explanation can let you explore an idea, but its appearance alone does not verify the underlying data or the application being discussed. Ask the agent to identify the inputs and explain what it rendered.

## Choose between a reply, a browser, and a capture

| What you need                                      | Use                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| An explanation rendered as HTML                    | A visual reply                                                             |
| An existing site with a reusable signed-in session | The preview browser with [browser import](/learn/workspace/browser-import) |
| A picture of the window you are using              | A [SnapShot](/learn/workspace/snapshots)                                   |
| A review of code that produced the UI              | The [source-control diff](/learn/workspace/source-control)                 |

A visual reply is an answer artifact. Browser import supplies cookies to a browser profile. A SnapShot supplies visual context to the agent. You can combine them by capturing a problem window, asking for an annotated explanation, and reviewing the code changes separately.

On macOS, [setting T3 Code as the default browser](/learn/workspace/default-browser) provides another way to bring an existing web page into a thread. It does not change what an HTML reply represents.

## Understand preview setup and saved images

Before publishing a visual reply, agents can inspect screenshots through a small headless browser T3 Code keeps for itself. It does not use a browser you installed. The first preview on a machine downloads that browser into T3 Code's data folder, about 120 MB, so setup may take a minute.

Remote environment browser tabs use the same browser download. Some Linux hosts need additional browser-host setup before it starts. Pages can still publish without it, so a published page alone does not confirm that browser-based inspection succeeded.

Local image paths can be included in a page. T3 Code embeds those images at publication, which keeps the page usable after the original files move or disappear. The page itself belongs to the thread. Deleting the thread deletes its visual pages.

## Use MCP apps when a connected tool returns one

MCP apps are another kind of interactive content in a thread. A compatible MCP server returns an app with its tool result, and T3 Code shows the app in place of that tool call. The documented provider support is Codex; other providers show ordinary tool calls.

An app can invoke tools on its own server and send a message to the thread. T3 Code asks before messages and before tool calls unless the server marks the tool read-only. Mobile adds confirmation before opening links, and T3 Code asks before saving an offered file.

An app remains viewable after the agent stops. Interaction requires the agent in its originating thread to be running. If it reports that it is unavailable, send a message in that thread first.

## Next steps

- Use [terminal history](/learn/workspace/terminal) when the evidence you need is exact command output.
- Return to the [workspace overview](/learn/workspace) to choose the right capture or review workflow.
