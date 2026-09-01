import QtQuick
import Qt.labs.lottieqt

// The cat at play (cat-playing.json), fitted into whatever box it is given.
// Qt Lottie paints at the frame size the file declares, so the painter is
// scaled instead of the item. Needs the Qt Lottie module (qt6-lottie); the
// dashboard falls back to the agent's initial when the import fails.
LottieAnimation {
    id: cat

    // The file's frame (its "w" and "h"); the host resizes the item.
    readonly property size frame: Qt.size(1070, 456)

    implicitHeight: width * frame.height / frame.width
    source: "cat-playing.json"
    autoPlay: true
    loops: LottieAnimation.Infinite
    quality: LottieAnimation.HighQuality
    contentsScale: Math.min(width / frame.width, height / frame.height)
}
