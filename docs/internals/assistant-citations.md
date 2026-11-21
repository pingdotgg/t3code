# Assistant citations

Citations carry the selected excerpt and source identity in ordinary message text.
Drafts, clipboard copies, stashes, and sent messages keep that representation
without a separate citation store. The saved quote remains usable when its source
disappears or changes. The [shared format](../../packages/shared/src/assistantCitations.ts) uses
stable environment IDs without a browser origin, so moving between local, remote,
and tunnel connections does not change a citation's identity.

Source navigation is best effort. [Text selectors](../../apps/web/src/lib/assistantTextSelection.ts)
refer to rendered text after whitespace normalization, measured in UTF-16 units.
They cannot be applied to raw Markdown. The original excerpt keeps its whitespace;
normalization is only for locating it. Repeated text needs an unambiguous context
match, even if one occurrence still sits at the saved offsets. Guessing could
highlight the wrong claim. Mobile's native selection reports only text, so when a
passage repeats within its block the user picks the occurrence, and mobile saves
that occurrence's offsets and context like any other selector.

Released servers and clients reject a citation link with an unknown query key and
send or show it unexpanded. Adding a field to the link needs a new link version.

Navigation owns the highlight's lifetime across virtual-row remounts. The source
row must be fetched, unfolded, mounted, and measured before quote positioning
takes over from normal timeline scrolling. Remounting must not revive a dismissed
highlight. The [navigation hash](../../apps/web/src/lib/assistantCitationNavigation.ts)
uses base64url because router normalization otherwise decodes whitespace and
source IDs inside the citation URI.

An HTML render is cited by its turn item ID in the message slot. Its sandboxed
page reports selections over the [render bridge](../../packages/shared/src/htmlRender.ts),
and navigation stops at the render's row because the host cannot read or
highlight text inside the frame.

Expand citations with the [shared formatter](../../packages/shared/src/assistantCitations.ts)
before dispatch to a provider adapter. Send the saved excerpt without looking up
the source, distinguish quoted reference material from the user's comment, and
leave persisted messages in their original form. Input limits apply after
expansion as well as before it. A draft that fits as encoded links can exceed the
provider limit once expanded.
