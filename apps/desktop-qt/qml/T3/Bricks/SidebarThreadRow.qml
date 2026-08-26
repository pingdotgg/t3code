import QtQuick
import QtQuick.Layouts
import T3.Shell

// One thread (or draft) row of the Sidebar brick.
Item {
    id: row

    required property var item
    required property bool active

    signal activated

    readonly property color textColor: Theme.color("sidebarForeground", "#e4e4e7")
    readonly property color mutedColor: Theme.color("sidebarMutedForeground", "#8b8b93")
    readonly property color statusColor: {
        switch (item.status) {
        case "approval":
            return Theme.color("warning", "#e0af68");
        case "input":
            return Theme.color("accent", "#7aa2f7");
        case "working":
            return Theme.color("update", "#9ece6a");
        case "monitoring":
            return Theme.color("textMuted", "#9aa5ce");
        case "failed":
            return Theme.color("error", "#f7768e");
        default:
            return "transparent";
        }
    }

    implicitHeight: 44

    Rectangle {
        anchors.fill: parent
        anchors.leftMargin: 6
        anchors.rightMargin: 6
        radius: 6
        color: row.active ? Theme.color("sidebarRowSelected", "#2a2a30") : hover.hovered ? Theme.color("sidebarRowHover", "#1c1c21") : "transparent"
    }

    HoverHandler {
        id: hover
    }

    TapHandler {
        onTapped: row.activated()
    }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 14
        anchors.rightMargin: 14
        spacing: 8

        Rectangle {
            Layout.preferredWidth: 7
            Layout.preferredHeight: 7
            radius: 3.5
            color: row.statusColor
            visible: row.statusColor.a > 0
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 1

            Text {
                Layout.fillWidth: true
                text: row.item.title
                color: row.textColor
                font.pixelSize: 13
                font.bold: row.item.unread === true
                elide: Text.ElideRight
            }

            Text {
                Layout.fillWidth: true
                visible: text.length > 0
                text: row.item.statusLabel ?? row.item.branch ?? ""
                color: row.mutedColor
                font.pixelSize: 11
                elide: Text.ElideRight
            }
        }
    }
}
