import QtQuick
import QtQuick.Layouts
import T3.Shell

// One thread (or draft) row of the Sidebar brick: a card for pinned and
// active threads (project, status or age, title, branch), a slim line for
// snoozed and settled ones.
Item {
    id: row

    required property var item
    required property bool active
    property bool slim: false
    property string projectName: ""

    signal activated
    signal menuRequested(real windowX, real windowY)

    readonly property color textColor: Theme.color("sidebarForeground", "#e4e4e7")
    readonly property color secondaryColor: Theme.color("secondaryLabel", "#8b8b93")
    // Themes may colour the project and branch lines and mark the active
    // row with a bar; without those roles the row stays monochrome.
    readonly property color projectColor: Theme.color("projectForeground", secondaryColor)
    readonly property color branchColor: Theme.color("branchForeground", secondaryColor)
    readonly property color indicatorColor: Theme.color("sidebarActiveIndicator", "transparent")
    readonly property string statusIcon: {
        switch (item.status) {
        case "working":
        case "monitoring":
            return "circle-dashed";
        default:
            return "";
        }
    }
    readonly property color statusColor: {
        switch (item.status) {
        case "approval":
            return Theme.color("warning", "#f59e0b");
        case "input":
            return Theme.color("info", "#818cf8");
        case "working":
        case "monitoring":
            return Theme.color("info", "#38bdf8");
        case "failed":
            return Theme.color("error", "#f87171");
        default:
            return row.secondaryColor;
        }
    }
    readonly property bool showStatus: item.statusLabel !== null && item.statusLabel !== undefined && item.status !== "ready"
    readonly property string ageLabel: relativeAge(item.updatedAt)

    function relativeAge(iso) {
        if (!iso) {
            return "";
        }
        const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
        if (seconds < 60) {
            return qsTr("now");
        }
        if (seconds < 3600) {
            return qsTr("%1m").arg(Math.floor(seconds / 60));
        }
        if (seconds < 86400) {
            return qsTr("%1h").arg(Math.floor(seconds / 3600));
        }
        if (seconds < 86400 * 30) {
            return qsTr("%1d").arg(Math.floor(seconds / 86400));
        }
        return qsTr("%1mo").arg(Math.floor(seconds / (86400 * 30)));
    }

    implicitHeight: slim ? 36 : 78
    Accessible.role: Accessible.ListItem
    Accessible.name: item.title

    Rectangle {
        anchors.fill: parent
        radius: 8
        color: row.active ? Theme.color("sidebarRowActive", "#2a2a30") : hover.hovered ? Theme.color("sidebarRowHover", "#1c1c21") : "transparent"

        Behavior on color {
            ColorAnimation {
                duration: 120
            }
        }
    }

    Rectangle {
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.topMargin: 8
        anchors.bottomMargin: 8
        width: 3
        radius: 1.5
        color: row.indicatorColor
        visible: row.active && row.indicatorColor.a > 0
    }

    HoverHandler {
        id: hover
    }

    TapHandler {
        acceptedButtons: Qt.LeftButton
        onTapped: row.activated()
    }

    TapHandler {
        acceptedButtons: Qt.RightButton
        onTapped: eventPoint => {
            const p = row.mapToItem(null, eventPoint.position.x, eventPoint.position.y);
            row.menuRequested(p.x, p.y);
        }
    }

    // Slim line: dimmed folder, title, age.
    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 10
        anchors.rightMargin: 10
        spacing: 10
        visible: row.slim

        ShellIcon {
            name: "folder"
            size: 16
            color: row.secondaryColor
            opacity: hover.hovered ? 1 : 0.4
            Layout.alignment: Qt.AlignVCenter

            Behavior on opacity {
                NumberAnimation {
                    duration: 120
                }
            }
        }

        Text {
            Layout.fillWidth: true
            text: row.item.title
            color: Qt.alpha(row.secondaryColor, 0.7)
            font.pixelSize: 14
            font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
            elide: Text.ElideRight
        }

        Text {
            text: row.ageLabel
            color: row.secondaryColor
            font.pixelSize: 12
            font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
        }
    }

    // Card: project line, title, branch.
    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 10
        anchors.rightMargin: 10
        anchors.topMargin: 8
        anchors.bottomMargin: 8
        spacing: 0
        visible: !row.slim

        RowLayout {
            Layout.fillWidth: true
            Layout.preferredHeight: 20
            spacing: 6

            ShellIcon {
                name: "folder"
                size: 16
                color: row.projectColor
                Layout.alignment: Qt.AlignVCenter
            }

            Text {
                Layout.fillWidth: true
                text: row.projectName
                color: row.projectColor
                font.pixelSize: 12
                font.weight: Font.Medium
                font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                elide: Text.ElideRight
            }

            ShellIcon {
                visible: row.showStatus && row.statusIcon.length > 0
                name: row.statusIcon
                size: 14
                color: row.statusColor
                Layout.alignment: Qt.AlignVCenter
            }

            Text {
                text: row.showStatus ? row.item.statusLabel : row.ageLabel
                color: row.showStatus ? row.statusColor : row.secondaryColor
                font.pixelSize: 12
                font.weight: Font.Medium
                font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
            }
        }

        Text {
            Layout.fillWidth: true
            Layout.topMargin: 4
            text: row.item.title
            color: row.item.unread === true ? row.textColor : Qt.alpha(row.textColor, 0.9)
            font.pixelSize: 14
            font.weight: Font.Medium
            font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
            elide: Text.ElideRight
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 2
            spacing: 6

            ShellIcon {
                visible: row.item.branch !== null && row.item.branch !== undefined
                name: "git-branch"
                size: 12
                color: row.branchColor
                Layout.alignment: Qt.AlignVCenter
            }

            Text {
                Layout.fillWidth: true
                text: row.item.branch ?? ""
                color: row.branchColor
                font.pixelSize: 12
                font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                elide: Text.ElideRight
            }
        }
    }
}
