# moved chat plugin follow-up

17 source files written under `/tmp/v3r3/out/`, plus this report. each source starts from `90c455ff8f` and changes only component wrapping, moved plugin contexts, and the assistant markdown environment prop. the worktree and git state were not modified. no formatter, tests, typecheck, lint, build, server, or browser ran. runtime behavior is unverified.

## source files written

- `apps/web/src/components/chat/TimelineAssistantRows.tsx`
- `apps/web/src/components/chat/TimelineUserMessageRow.tsx`
- `apps/web/src/components/chat/TimelineWorkEntryRow.tsx`
- `apps/web/src/components/chat/TimelineV2EventRow.tsx`
- `apps/web/src/components/chat/TimelineRowParts.tsx`
- `apps/web/src/components/chat/TimelineMinimap.tsx`
- `apps/web/src/components/chat/TimelineToolActivityIcon.tsx`
- `apps/web/src/components/chat/TimelineWorkGroupRows.tsx`
- `apps/web/src/components/chat/UserMessageContextChips.tsx`
- `apps/web/src/components/chat/ChatMarkdownMedia.tsx`
- `apps/web/src/components/chat/MarkdownCodeBlock.tsx`
- `apps/web/src/components/chat/MarkdownTable.tsx`
- `apps/web/src/components/chat/MarkdownDetails.tsx`
- `apps/web/src/components/chat/MarkdownMermaidCodeBlock.tsx`
- `apps/web/src/components/chat/MarkdownExternalLink.tsx`
- `apps/web/src/components/chat/MarkdownFileLink.tsx`
- `apps/web/src/components/chat/timelineRowContext.ts`

## complete original component-wrapper inventory

73 original component wrappers: 65 moved and re-applied here, 8 retained in protected outputs, 0 dropped. the following entries give every original id and its destination; unchanged names mean only the module path changed. the original function or memo value in each moved module is named `PluginOriginalX`, and `X` exports its `definePluginComponent` wrapper. upstream bodies, props, memo comparators, helpers, and other exports are preserved.

### `apps/web/src/components/chat/MessagesTimeline.tsx`

- `component:components/chat/MessagesTimeline/TimelineListFooter`: retained in the existing protected output, unchanged.
- `component:components/chat/MessagesTimeline/TimelineHistoryControl`: retained in the existing protected output, unchanged.
- `component:components/chat/MessagesTimeline/TimelineMinimap` -> `component:components/chat/TimelineMinimap/TimelineMinimap`.
- `component:components/chat/MessagesTimeline/TimelineMinimapNavigationButton` -> `component:components/chat/TimelineMinimap/TimelineMinimapNavigationButton`.
- `component:components/chat/MessagesTimeline/WorktreeSetupTimelineRow`: retained in the existing protected output, unchanged.
- `component:components/chat/MessagesTimeline/ContextCompactionTimelineRow`: retained in the existing protected output, unchanged.
- `component:components/chat/MessagesTimeline/UserVideoAttachment` -> `component:components/chat/TimelineUserMessageRow/UserVideoAttachment`.
- `component:components/chat/MessagesTimeline/MessageAuthorHeading` -> `component:components/chat/TimelineRowParts/MessageAuthorHeading`.
- `component:components/chat/MessagesTimeline/UserTimelineRow` -> `component:components/chat/TimelineUserMessageRow/UserTimelineRow`.
- `component:components/chat/MessagesTimeline/UserMessageIntentMarker` -> `component:components/chat/TimelineUserMessageRow/UserMessageIntentMarker`.
- `component:components/chat/MessagesTimeline/RevertUserMessageButton` -> `component:components/chat/TimelineUserMessageRow/RevertUserMessageButton`.
- `component:components/chat/MessagesTimeline/TimelineRowTimestamp` -> `component:components/chat/TimelineRowParts/TimelineRowTimestamp`.
- `component:components/chat/MessagesTimeline/TurnFoldTimelineRow`: retained in the existing protected output, unchanged.
- `component:components/chat/MessagesTimeline/AttemptFoldTimelineRow`: retained in the existing protected output, unchanged.
- `component:components/chat/MessagesTimeline/AssistantTimelineRow` -> `component:components/chat/TimelineAssistantRows/AssistantTimelineRow`.
- `component:components/chat/MessagesTimeline/AssistantForkButton` -> `component:components/chat/TimelineAssistantRows/AssistantForkButton`.
- `component:components/chat/MessagesTimeline/AssistantMetaTimelineRow` -> `component:components/chat/TimelineAssistantRows/AssistantMetaTimelineRow`.
- `component:components/chat/MessagesTimeline/AssistantMessageMeta` -> `component:components/chat/TimelineAssistantRows/AssistantMessageMeta`.
- `component:components/chat/MessagesTimeline/AssistantCopyButton` -> `component:components/chat/TimelineAssistantRows/AssistantCopyButton`.
- `component:components/chat/MessagesTimeline/ProposedPlanTimelineRow` -> `component:components/chat/TimelineAssistantRows/ProposedPlanTimelineRow`.
- `component:components/chat/MessagesTimeline/V2EventTimelineRow` -> `component:components/chat/TimelineV2EventRow/V2EventTimelineRow`.
- `component:components/chat/MessagesTimeline/WorkingTimer` -> `component:components/chat/TimelineWorkGroupRows/WorkingTimer`.
- `component:components/chat/MessagesTimeline/ExpandedWorkGroupEntries` -> `component:components/chat/TimelineWorkGroupRows/ExpandedWorkGroupEntries`.
- `component:components/chat/MessagesTimeline/ActivityShimmerOverlay` -> `component:components/chat/TimelineRowParts/ActivityShimmerOverlay`.
- `component:components/chat/MessagesTimeline/WorkingTimelineRow` -> `component:components/chat/TimelineWorkGroupRows/WorkingTimelineRow`.
- `component:components/chat/MessagesTimeline/BackgroundWorktreeSetupChip` -> `component:components/chat/TimelineWorkGroupRows/BackgroundWorktreeSetupChip`.
- `component:components/chat/MessagesTimeline/CompactingLabel` -> `component:components/chat/TimelineWorkGroupRows/CompactingLabel`.
- `component:components/chat/MessagesTimeline/ThinkingTimelineRow` -> `component:components/chat/TimelineWorkGroupRows/ThinkingTimelineRow`.
- `component:components/chat/MessagesTimeline/LiveActivityRow` -> `component:components/chat/TimelineWorkGroupRows/LiveActivityRow`.
- `component:components/chat/MessagesTimeline/LiveActivityContent` -> `component:components/chat/TimelineWorkGroupRows/LiveActivityContent`.
- `component:components/chat/MessagesTimeline/LiveWorkEntryTimelineRow` -> `component:components/chat/TimelineWorkGroupRows/LiveWorkEntryTimelineRow`.
- `component:components/chat/MessagesTimeline/WorkGroupToggleTimelineRow` -> `component:components/chat/TimelineWorkGroupRows/WorkGroupToggleTimelineRow`.
- `component:components/chat/MessagesTimeline/WorkGroupHeader` -> `component:components/chat/TimelineWorkGroupRows/WorkGroupHeader`.
- `component:components/chat/MessagesTimeline/AssistantChangedFilesSectionInner` -> `component:components/chat/TimelineAssistantRows/AssistantChangedFilesSectionInner`.
- `component:components/chat/MessagesTimeline/UserMessageMentionChip` -> `component:components/chat/UserMessageContextChips/UserMessageMentionChip`.
- `component:components/chat/MessagesTimeline/UserMessageContextChip` -> `component:components/chat/UserMessageContextChips/UserMessageContextChip`.
- `component:components/chat/MessagesTimeline/UserMessagePullRequestContextChip` -> `component:components/chat/UserMessageContextChips/UserMessagePullRequestContextChip`.
- `component:components/chat/MessagesTimeline/UserMessagePreviewAnnotationDetails` -> `component:components/chat/UserMessageContextChips/UserMessagePreviewAnnotationDetails`.
- `component:components/chat/MessagesTimeline/UserMessageElementDetails` -> `component:components/chat/UserMessageContextChips/UserMessageElementDetails`.
- `component:components/chat/MessagesTimeline/UnavailableUserMessageContextChip` -> `component:components/chat/UserMessageContextChips/UnavailableUserMessageContextChip`.
- `component:components/chat/MessagesTimeline/UserMessageContextReferenceChip` -> `component:components/chat/UserMessageContextChips/UserMessageContextReferenceChip`.
- `component:components/chat/MessagesTimeline/UserMessageReviewCommentCard` -> `component:components/chat/UserMessageContextChips/UserMessageReviewCommentCard`.
- `component:components/chat/MessagesTimeline/BrowserAppIcon` -> `component:components/chat/TimelineToolActivityIcon/BrowserAppIcon`.
- `component:components/chat/MessagesTimeline/ToolActivityIconView` -> `component:components/chat/TimelineToolActivityIcon/ToolActivityIconView`.
- `component:components/chat/MessagesTimeline/NativeAppToolActivityIcon` -> `component:components/chat/TimelineToolActivityIcon/NativeAppToolActivityIcon`.
- `component:components/chat/MessagesTimeline/ToolActivityImageIcon` -> `component:components/chat/TimelineToolActivityIcon/ToolActivityImageIcon`.
- `component:components/chat/MessagesTimeline/WorkEntryIcon` -> `component:components/chat/TimelineToolActivityIcon/WorkEntryIcon`.
- `component:components/chat/MessagesTimeline/ReasoningTraceContent` -> `component:components/chat/TimelineWorkEntryRow/ReasoningTraceContent`.
- `component:components/chat/MessagesTimeline/WorkEntryLogRow` -> `component:components/chat/TimelineWorkEntryRow/WorkEntryLogRow`.
- `component:components/chat/MessagesTimeline/QuestionAnswerHistory` -> `component:components/chat/TimelineWorkEntryRow/QuestionAnswerHistory`.
- `component:components/chat/MessagesTimeline/TimelineRowContent`: retained in the existing protected output, unchanged.
- `component:components/chat/MessagesTimeline/V2SubagentGroup` -> `component:components/chat/TimelineV2EventRow/V2SubagentGroup`.
- `component:components/chat/MessagesTimeline/WorkGroupSection` -> `component:components/chat/TimelineWorkGroupRows/WorkGroupSection`.
- `component:components/chat/MessagesTimeline/AssistantChangedFilesSection` -> `component:components/chat/TimelineAssistantRows/AssistantChangedFilesSection`.
- `component:components/chat/MessagesTimeline/CollapsibleUserMessageBody` -> `component:components/chat/TimelineUserMessageRow/CollapsibleUserMessageBody`.
- `component:components/chat/MessagesTimeline/UserMessageBody` -> `component:components/chat/TimelineUserMessageRow/UserMessageBody`.
- `component:components/chat/MessagesTimeline/SimpleWorkEntryRow` -> `component:components/chat/TimelineWorkEntryRow/SimpleWorkEntryRow`.

### `apps/web/src/components/ChatMarkdown.tsx`

- `component:components/ChatMarkdown/CodexArtifactTemplateCard`: retained in the existing protected output, unchanged.
- `component:components/ChatMarkdown/MarkdownTable` -> `component:components/chat/MarkdownTable/MarkdownTable`.
- `component:components/ChatMarkdown/MarkdownDetails` -> `component:components/chat/MarkdownDetails/MarkdownDetails`.
- `component:components/ChatMarkdown/MarkdownCodeBlockTitleContent` -> `component:components/chat/MarkdownCodeBlock/MarkdownCodeBlockTitleContent`.
- `component:components/ChatMarkdown/MarkdownCodeBlock` -> `component:components/chat/MarkdownCodeBlock/MarkdownCodeBlock`.
- `component:components/ChatMarkdown/MarkdownMermaidCodeBlock` -> `component:components/chat/MarkdownMermaidCodeBlock/MarkdownMermaidCodeBlock`.
- `component:components/ChatMarkdown/SuspenseShikiCodeBlock` -> `component:components/chat/MarkdownCodeBlock/SuspenseShikiCodeBlock`.
- `component:components/ChatMarkdown/UncachedShikiCodeBlock` -> `component:components/chat/MarkdownCodeBlock/UncachedShikiCodeBlock`.
- `component:components/ChatMarkdown/ChatMarkdownMediaUnavailableLabel` -> `component:components/chat/ChatMarkdownMedia/ChatMarkdownMediaUnavailableLabel`.
- `component:components/ChatMarkdown/ChatMarkdownImageFallback` -> `component:components/chat/ChatMarkdownMedia/ChatMarkdownImageFallback`.
- `component:components/ChatMarkdown/ChatMarkdownImage` -> `component:components/chat/ChatMarkdownMedia/ChatMarkdownImage`.
- `component:components/ChatMarkdown/ChatMarkdownVideo` -> `component:components/chat/ChatMarkdownMedia/ChatMarkdownVideo`.
- `component:components/ChatMarkdown/MarkdownExternalLinkContent` -> `component:components/chat/MarkdownExternalLink/MarkdownExternalLinkContent`.
- `component:components/ChatMarkdown/MarkdownLinkFavicon` -> `component:components/chat/MarkdownExternalLink/MarkdownLinkFavicon`.
- `component:components/ChatMarkdown/ChatMarkdownAssetImage` -> `component:components/chat/ChatMarkdownMedia/ChatMarkdownAssetImage`.
- `component:components/ChatMarkdown/MarkdownFileLink` -> `component:components/chat/MarkdownFileLink/MarkdownFileLink`.

## contexts

- `components/chat/MessagesTimeline/TimelineRowCtx` -> `components/chat/timelineRowContext/TimelineRowCtx`. the existing shared module exports the sole context instance; the resolved timeline and moved rows already import it. no import from a row back into `MessagesTimeline.tsx` was added.
- `components/chat/MessagesTimeline/TimelineRowActivityCtx` -> `components/chat/timelineRowContext/TimelineRowActivityCtx`. the existing shared module exports the sole context instance; the resolved timeline and moved rows already import it. no import from a row back into `MessagesTimeline.tsx` was added.
- `components/chat/MessagesTimeline/WorkGroupViewCtx` -> `components/chat/timelineRowContext/WorkGroupViewCtx`. the existing shared module exports the sole context instance; the resolved timeline and moved rows already import it. no import from a row back into `MessagesTimeline.tsx` was added.
- `components/ChatMarkdown/MarkdownLinkContext` -> `components/chat/ChatMarkdownMedia/MarkdownLinkContext`. the existing exported media context now uses `createPluginContext`; the protected markdown output already imports that same context.
- `components/ChatMarkdown/ChatMarkdownRendererContext`: retained unchanged in the protected markdown output.

## feature wrappers and props

- `definePluginFeature("chat.timeline", BuiltinMessagesTimeline)` remains in the protected timeline output.
- `definePluginFeature("markdown", memo(ChatMarkdown))` and each `markdown.element.${name}` renderer wrapper remain in the protected markdown output.
- the added `MessagesTimelineProps.threadRef?: ScopedThreadRef | null` and explicit-null handling remain in the protected timeline output.
- the added assistant `<ChatMarkdown environmentId={ctx.activeThreadEnvironmentId}>` prop is re-applied in `TimelineAssistantRows.tsx:47`.
- the requested `apps/web/src/components/chat/ChatMarkdown.tsx` path does not exist. the actual file is `apps/web/src/components/ChatMarkdown.tsx`; it is both listed in `uu.txt` and already present under `out`, so it was not written. its existing output already has `environmentId?: EnvironmentId | undefined` at line 227, destructures it as `explicitEnvironmentId` at line 441, and resolves `threadRef?.environmentId ?? explicitEnvironmentId ?? null` at line 502. the actual `22d022137e` markdown diff does not newly introduce this already-existing prop.

## required edit in another agent's protected output

`/tmp/v3r3/out/apps/web/src/components/ChatMarkdown.tsx` must import the wrapped exports directly, then delete its 11 duplicate local wrappers. otherwise the same ids register twice and the markdown path nests plugin wrappers. do not change the retained `CodexArtifactTemplateCard`, renderer context, renderer map, or `markdown` feature wrapper.

remove `as PluginOriginalX` from the imports at lines 189-203 for:

- `MarkdownCodeBlock`
- `SuspenseShikiCodeBlock`
- `MarkdownMermaidCodeBlock`
- `MarkdownTable`
- `MarkdownDetails`
- `ChatMarkdownAssetImage`
- `ChatMarkdownImage`
- `ChatMarkdownImageFallback`
- `ChatMarkdownVideo`
- `MarkdownExternalLinkContent`
- `MarkdownFileLink`

delete the corresponding `const X = definePluginComponent(..., PluginOriginalX)` declarations from line 1637 to the end of the current output. retain the `CodexArtifactTemplateCard` declaration at lines 1633-1636. all 11 imported names now refer to the wrappers exported by this follow-up's defining modules. `MarkdownCodeBlockTitleContent`, `UncachedShikiCodeBlock`, `ChatMarkdownMediaUnavailableLabel`, and `MarkdownLinkFavicon` are wrapped inside their moved modules, so no new markdown imports are needed for them.

no edit is needed in the resolved `MessagesTimeline.tsx`. it already imports the moved row components and shared contexts. `TimelineOverlays.tsx` and `ThreadTimeline.tsx` contain no component from the original wrapper inventory and were left alone.

## deletions and judgment calls

- no files to delete; no wrappers dropped because upstream deleted a component. all original wrapped components remain, with unchanged names.
- `UserTimelineRow` still exists beneath upstream's new `UserMessageRow` dispatcher, so the original wrapper follows `UserTimelineRow`; automation dispatch and the new row variants remain intact.
- reused the existing `timelineRowContext.ts` shared module; no new context module or circular import was introduced. context keys follow their new defining module paths.
- preserved new upstream controls and components without adding unrelated plugin slots.
