# Proposed: workspace file actions follow the file

Equivalent references to a live workspace file should offer the same supported
core actions, resolved against the environment and workspace that own the
reference. Presentation can use a context menu, a keyboard menu command, or a
native touch menu. An action must retain its meaning and target across those
presentations; there should be one obvious command for each outcome.

This is a proposed cross-surface decision. The existing foundation is the shared
[file menu](../../apps/web/src/fileContextMenu.ts) from
[#11842](https://github.com/pingdotgg/t3code/pull/11842). The open
[#11859](https://github.com/pingdotgg/t3code/pull/11859) extends chat chips and the
shared path resolver; its changes are not assumed to have landed here. Apple's
[Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus)
is supporting design material, not evidence of prior maintainer ratification.

The owning environment determines available editors, reveal support and file
manager wording, including remote environments. Missing ownership or an
unresolvable path must withhold actions rather than guess the primary environment
or a similarly named file. Captured attachments, snapshots, skill references and
citations are different objects; their names do not authorize live workspace
operations. A directory mention is not treated as a file.

For web and Electron, composer file mentions use the same shared menu as file
lists and diffs. Both plain and rich composer modes use the Tiptap mention node.
Opening or dismissing a menu must preserve the composer text, context records and
selection. Keyboard context-menu invocation and pointer invocation target the
same file. Ordinary activation continues to preview the file.

This independent change covers workspace-relative composer file mentions. Absolute
and UNC path support remains owned by #11859's shared resolver work; unresolved
mentions expose no misleading file actions until that dependency lands. The
React Native client keeps its own touch presentations; this implementation does
not claim new native file-menu coverage.

Verify advertised editor submenu selection, remote ownership, unresolved and
non-file references, both composer modes, and menu dismissal without editing or
caret loss. Source tests can establish identity and dispatch rules; real-client
interaction is required to establish focus and selection behavior.
