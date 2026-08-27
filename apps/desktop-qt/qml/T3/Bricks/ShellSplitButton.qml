import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// The header's welded pill: an outline action with a chevron half that opens
// a menu. Attach the menu as a child and open it from `menuRequested`.
Item {
    id: split

    property string text: ""
    property string iconName: ""
    property bool actionEnabled: true
    property bool menuEnabled: true
    property string toolTip: ""
    property real maximumTextWidth: 200
    // Icon only, for narrow header strips.
    property bool compact: false

    signal clicked
    signal menuRequested

    implicitHeight: 24
    implicitWidth: row.implicitWidth
    opacity: enabled ? 1 : 0.64

    Rectangle {
        anchors.fill: parent
        radius: Math.min(Theme.radius, 8)
        color: Qt.alpha(Theme.color("input", "#27272a"), 0.32)
        border.color: Theme.color("input", "#27272a")
        border.width: 1
    }

    RowLayout {
        id: row

        anchors.fill: parent
        spacing: 0

        ShellButton {
            id: action

            Layout.fillHeight: true
            Layout.maximumWidth: split.maximumTextWidth
            subtle: true
            radius: 7
            leftPadding: 7
            rightPadding: 7
            font.pixelSize: 12
            iconName: split.iconName
            enabled: split.actionEnabled
            text: split.compact ? "" : split.text
            Accessible.name: split.text
            ToolTip.visible: hovered && (split.toolTip.length > 0 || split.compact)
            ToolTip.text: split.toolTip.length > 0 ? split.toolTip : split.text
            ToolTip.delay: 400
            onClicked: split.clicked()
        }

        Rectangle {
            Layout.fillHeight: true
            Layout.topMargin: 1
            Layout.bottomMargin: 1
            implicitWidth: 1
            color: Theme.color("input", "#27272a")
        }

        ShellButton {
            Layout.fillHeight: true
            Layout.preferredWidth: 24
            subtle: true
            radius: 7
            chevron: true
            chevronSize: 16
            enabled: split.menuEnabled
            Accessible.name: qsTr("More options")
            onClicked: split.menuRequested()
        }
    }
}
