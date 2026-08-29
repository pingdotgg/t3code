# Composer banners

Web and desktop use `ComposerBanner` in `apps/web/src/components/chat/ComposerBanner.tsx`
for content attached above the composer. Native mobile has a separate UI.

The parent owns placement, padding, icon and action columns, and the seam against the
composer. Consumers provide content and behavior; they should not add offsets or
padding to reproduce that layout.
Layout uses Tailwind utilities on these components, including the shared row slots
and container variants.

```tsx
<ComposerBanner.Attachment>
  <ComposerBanner.Root>
    <ComposerBanner.Row>
      <ComposerBanner.Icon>
        <InfoIcon />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>Server update available</ComposerBanner.Content>
      <ComposerBanner.Actions>
        <Button size="xs" onClick={update}>
          Update
        </Button>
        <ComposerBanner.Dismiss aria-label="Dismiss update notice" onClick={dismiss} />
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  </ComposerBanner.Root>
</ComposerBanner.Attachment>
```

- `Attachment` provides the inset and overlap. `Dock` arranges multiple roots, such
  as tasks and stash, in normal flow. `Root width="content"` sizes a standalone tab.
- `Root placement="floating"` closes the outline for an expanded hidden notice.
  `variant` controls the surface severity without changing its geometry.
- `Row`, `Icon`, `Content`, and `Actions` share columns. Without `Icon`, content keeps
  the normal row inset, aligned with the left edge of other rows' icons. An empty `Icon`
  reserves the column when a child row should align with its header. Icons use a 12px
  glyph in a 24px desktop / 28px narrow slot.
- `Children` begins immediately after its header. It supports `render={<ul />}` and
  rows support `render={<li />}` for task lists. There is no extra header-to-list gap.
  Wrap long lists in `Scroll` to bound their height and fade overflowing edges using
  the app's shared scroll area. Keep the header outside it so the status stays visible.
- `Count` shares numeric typography between task progress and stash controls. Inside
  a banner it reserves the same slot width as an icon, keeping counters away from the border.
  `Separator` divides inline status details with a dot and the same 4px spacing on each side,
  whether inside flex content or an inline text line.
- `Row render={<button type="button" />}` makes the full row a disclosure control.
  The caller supplies its accessible label, expanded state, and toggle handler.
  `ToggleIcon` supplies a visual control without nesting another button.
- `Row layout="wrap-actions"` keeps actions together and lets them wrap beneath
  the header when a narrow banner cannot fit them inline. Notices and approvals
  use this layout; no per-notice breakpoints or offsets are needed. `Body` aligns freeform content
  such as questions to that same text column.

`ComposerBannerStack` owns notice priority presentation, stack expansion, and
animated dismissal. Its items supply title, description, actions, and optional
composed child rows. `ComposerServerUpdateStatus` renders both progress and failure details
inline with the title. The line truncates at its end on narrow screens; hover, focus, or click
to read the full status in a tooltip. The Settings presentation remains separate.
Failed update notices can be dismissed without clearing the runtime failure in Settings.
Dismissal follows that failure object across chat remounts; a new attempt can show a new failure.

`ComposerStashMenu` uses the same root, header, child rows, count, and scroll area as tasks.
It renders a native list with separate restore and delete buttons, so command-menu padding and
typography do not leak into the banner. Timestamps and attachment status inherit the banner's
text size. Arrow keys select an entry, Enter restores it, and Escape closes the drawer.

`ComposerActivityStatus` represents either a working turn or thread synchronization.
Loading and syncing take precedence over the timer and task UI until the thread is current.
`ChatComposer` hides task inputs during synchronization, including the summary, progress,
and expanded list. Its existing drawer reset closes the list when those inputs disappear.
The sync status uses the standalone activity row. Its icon spins unless reduced motion is
enabled. There is no separate sync banner.

The composer overlay is measured as a whole. Tabs no longer need absolute offsets
or a separate mutation observer to reserve space. The running timer updates its
text node without committing the composer and timeline every second.
