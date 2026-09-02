pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import T3.Shell

// One thread (or draft) row of the Sidebar brick: a card for pinned and
// active threads (project, status or age, title, branch), a slim line for
// snoozed and settled ones. Hovering or focusing the row swaps the status
// slot for the section's actions (snooze and settle, wake, un-settle), the
// same ones the page's sidebar shows on hover.
Item {
    id: row

    required property var item
    required property bool active
    property bool slim: false
    property string projectName: ""
    // Which sidebar group the row sits in: pinned, active, snoozed, settled
    // or draft. Decides the hover actions.
    property string section: "active"
    // Keyboard cursor: draws the focus ring and shows the actions.
    property bool focused: false
    property double ageNow: Date.now()

    signal activated
    signal menuRequested(real windowX, real windowY)
    signal settleRequested
    signal unsettleRequested
    signal snoozeRequested(real windowX, real windowY)
    signal unsnoozeRequested
    signal wokeDismissed

    readonly property color textColor: Theme.color("sidebarForeground", "#e4e4e7")
    readonly property color secondaryColor: Theme.color("secondaryLabel", "#8b8b93")
    // Themes may colour the project and branch lines and mark the active
    // row with a bar; without those roles the row stays monochrome.
    readonly property color projectColor: Theme.color("projectForeground", secondaryColor)
    readonly property color branchColor: Theme.color("branchForeground", secondaryColor)
    readonly property color indicatorColor: Theme.color("sidebarActiveIndicator", "transparent")
    readonly property color focusColor: Theme.color("focus", "#3b82f6")
    readonly property bool draft: section === "draft"
    readonly property bool woke: item.wokeAt !== null && item.wokeAt !== undefined
    readonly property bool parked: section === "snoozed" || section === "settled"
    readonly property bool canSettle: !draft && !parked && item.canSettle === true
    readonly property bool canSnooze: !draft && !parked && item.canSnooze === true
    readonly property bool hasActions: parked || canSettle || canSnooze
    readonly property bool showActions: hasActions && (hover.hovered || focused)
    // The status word the page's sidebar uses for each state; empty when the
    // row is at rest, then the slot shows the age (or the wake time).
    readonly property string statusWord: {
        switch (item.status) {
        case "working":
            return qsTr("Working");
        case "monitoring":
            return qsTr("Monitoring");
        case "approval":
            return qsTr("Approval");
        case "input":
            return qsTr("Input");
        case "failed":
            return qsTr("Failed");
        }
        if (row.woke) {
            return qsTr("Woke");
        }
        if (item.unread === true) {
            return qsTr("Done");
        }
        return "";
    }
    readonly property string statusIcon: {
        switch (item.status) {
        case "working":
            return "circle-dashed";
        case "failed":
            return "circle-x";
        }
        if (row.woke) {
            return "alarm-clock";
        }
        if (item.unread === true) {
            return "circle-check";
        }
        return "";
    }
    readonly property color statusColor: {
        switch (item.status) {
        case "approval":
            return Theme.color("warning", "#f59e0b");
        case "input":
            return Theme.color("accent", "#818cf8");
        case "working":
        case "monitoring":
            return Theme.color("info", "#38bdf8");
        case "failed":
            return Theme.color("error", "#f87171");
        }
        if (row.woke) {
            return Theme.color("warning", "#f59e0b");
        }
        if (item.unread === true) {
            return Theme.color("success", "#34d399");
        }
        return row.secondaryColor;
    }
    readonly property bool showStatus: statusWord.length > 0
    // In-flight and read-ready rows recede: prominence is for rows that need
    // a human (done, failed, woke) and the one that is open.
    readonly property bool recedes: !active && !woke && item.unread !== true && item.status !== "failed"
    readonly property string ageLabel: item.wakeLabel ? item.wakeLabel : relativeAge(item.updatedAt, ageNow)

    function relativeAge(iso, now) {
        if (!iso) {
            return "";
        }
        const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
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

    Timer {
        id: ageRefreshTimer
        objectName: "ageRefreshTimer"

        interval: 60000
        repeat: true
        running: row.visible && !row.item.wakeLabel
        onTriggered: row.ageNow = Date.now()
    }

    onItemChanged: ageNow = Date.now()

    function requestSnooze(button) {
        const p = button.mapToItem(null, 0, button.height);
        row.snoozeRequested(p.x, p.y);
    }

    implicitHeight: slim ? 36 : 78
    Accessible.role: Accessible.ListItem
    Accessible.name: item.title

    Rectangle {
        anchors.fill: parent
        radius: 8
        color: row.active ? Theme.color("sidebarRowActive", "#2a2a30") : hover.hovered ? Theme.color("sidebarRowHover", "#1c1c21") : "transparent"
        border.width: row.focused ? 1 : 0
        border.color: row.focusColor

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

    // The menu opens on press, anywhere on the row, like the page's.
    TapHandler {
        acceptedButtons: Qt.RightButton
        gesturePolicy: TapHandler.WithinBounds
        onPressedChanged: {
            if (pressed) {
                row.menuRequested(point.scenePosition.x, point.scenePosition.y);
            }
        }
    }

    // Row actions never take focus: the keyboard cursor stays on the list
    // and reaches them through the context menu.
    component RowAction: ShellButton {
        subtle: true
        focusPolicy: Qt.NoFocus
        implicitHeight: 22
        implicitWidth: 22
        iconSize: 14
        iconTint: row.secondaryColor
    }

    // The right-hand slot: the section's actions while hovered or focused,
    // the woke pill (click acknowledges the wake), else the status or age.
    component StatusSlot: RowLayout {
        spacing: 2

        RowAction {
            id: snoozeButton

            visible: row.showActions && row.canSnooze
            iconName: "clock"
            Accessible.name: qsTr("Snooze")
            onClicked: row.requestSnooze(snoozeButton)
        }

        RowAction {
            visible: row.showActions && row.canSettle
            iconName: "check"
            Accessible.name: qsTr("Settle")
            onClicked: row.settleRequested()
        }

        RowAction {
            visible: row.showActions && row.section === "snoozed"
            iconName: "alarm-clock-off"
            Accessible.name: qsTr("Wake")
            onClicked: row.unsnoozeRequested()
        }

        RowAction {
            visible: row.showActions && row.section === "settled"
            iconName: "undo-2"
            Accessible.name: qsTr("Un-settle")
            onClicked: row.unsettleRequested()
        }

        ShellButton {
            visible: row.woke && !row.showActions
            subtle: true
            focusPolicy: Qt.NoFocus
            implicitHeight: 22
            leftPadding: 6
            rightPadding: 6
            iconName: "alarm-clock"
            iconSize: 12
            font.pixelSize: 12
            text: qsTr("Woke")
            tint: row.statusColor
            iconTint: row.statusColor
            Accessible.name: qsTr("Dismiss woke")
            onClicked: row.wokeDismissed()
        }

        ShellIcon {
            visible: !row.showActions && !row.woke && row.showStatus && row.statusIcon.length > 0
            name: row.statusIcon
            size: 14
            color: row.statusColor
            Layout.alignment: Qt.AlignVCenter
        }

        Text {
            visible: !row.showActions && !row.woke
            text: row.showStatus ? row.statusWord : row.ageLabel
            color: row.showStatus ? row.statusColor : row.secondaryColor
            font.pixelSize: 12
            font.weight: Font.Medium
            font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
        }
    }

    // Slim line: dimmed folder, title, status or age.
    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 10
        anchors.rightMargin: 8
        spacing: 10
        visible: row.slim

        ShellIcon {
            name: "folder"
            size: 16
            color: row.secondaryColor
            opacity: hover.hovered || row.focused ? 1 : 0.4
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

        StatusSlot {
            Layout.alignment: Qt.AlignVCenter
        }
    }

    // Card: project line, title, branch.
    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 10
        anchors.rightMargin: 8
        anchors.topMargin: 8
        anchors.bottomMargin: 8
        spacing: 0
        visible: !row.slim

        RowLayout {
            Layout.fillWidth: true
            Layout.preferredHeight: 22
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

            StatusSlot {
                Layout.alignment: Qt.AlignVCenter
            }
        }

        Text {
            Layout.fillWidth: true
            Layout.topMargin: 2
            text: row.item.title
            color: row.recedes ? Qt.alpha(row.textColor, 0.72) : row.textColor
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
