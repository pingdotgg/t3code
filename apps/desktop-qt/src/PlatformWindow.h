#pragma once

class QWindow;

// Frosted backdrop behind a transparent window where the platform can draw it
// itself (macOS). Elsewhere the compositor owns blur (see the Linux notes in
// docs/internals/desktop-qt.md), so this is a no-op.
void applyWindowBlur(QWindow* window, bool enabled, bool dark);
