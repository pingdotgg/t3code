import QtQuick
import T3.Shell

// A rounded, hairlined panel for rices that float bricks in cards. Children
// fill the inside of the border; override color, border or radius per card.
Rectangle {
    id: card

    default property alias content: inner.data

    radius: Theme.radius
    color: Theme.color("surface", "#141416")
    border.color: Theme.color("border", "#27272a")
    border.width: 1

    Item {
        id: inner

        anchors.fill: parent
        anchors.margins: card.border.width
    }
}
