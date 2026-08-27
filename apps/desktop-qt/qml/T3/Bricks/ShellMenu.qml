import QtQuick
import QtQuick.Controls.Basic
import T3.Shell

// A popup menu in the page's clothes; use ShellMenuItem for entries.
Menu {
    id: control

    padding: 4
    implicitWidth: 220

    enter: Transition {
        NumberAnimation {
            property: "opacity"
            from: 0
            to: 1
            duration: 90
        }
    }

    exit: Transition {
        NumberAnimation {
            property: "opacity"
            from: 1
            to: 0
            duration: 70
        }
    }

    background: Rectangle {
        radius: Theme.radius
        color: Theme.color("surfaceOverlay", "#18181b")
        border.color: Theme.color("border", "#27272a")
        border.width: 1
    }
}
