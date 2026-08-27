import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Shapes
import T3.Shell
import T3.Bricks

// Rosé dashboard: an icon rail owns project scope and the app's places, the
// sidebar is just threads, and a notch of tabs hangs from the top of the
// page. The Dashboard tab pulls a widget drawer over the page: today and the
// calendar, the open workspace and its git state, thread meters, and the
// agent behind the composer.
Window {
    id: root

    readonly property var layoutState: Shell.state.layout ?? null
    readonly property bool sidebarCollapsed: layoutState ? layoutState.sidebarCollapsed : false
    readonly property var settingsState: Shell.state.settings ?? null
    readonly property bool settingsActive: settingsState ? settingsState.active : false
    readonly property var sidebarState: Shell.state.sidebar ?? null
    readonly property var projects: sidebarState ? sidebarState.projects : []
    readonly property var scopeKey: sidebarState ? sidebarState.scopeProjectKey : null
    readonly property var workspace: Shell.state.workspace ?? null
    readonly property var git: workspace ? workspace.git : null
    readonly property var composerState: Shell.state.composer ?? null
    readonly property bool composerReady: composerState !== null && composerState.target !== null
    readonly property var instance: composerReady ? (composerState.instances.find(entry => entry.instanceId === composerState.selectedInstanceId) ?? null) : null
    readonly property int attentionCount: composerReady ? composerState.pendingApprovalCount + composerState.pendingUserInputCount : 0
    readonly property int threadCount: sidebarState ? sidebarState.active.length + sidebarState.pinned.length : 0
    readonly property int meterPeak: sidebarState ? Math.max(1, threadCount, sidebarState.snoozed.length, sidebarState.settledTotal) : 1

    // The sidebar's width is the one animated layout value; the title pill
    // above it follows so the two collapse as one piece.
    property real sidebarSlot: sidebarCollapsed ? 0 : 272
    property bool drawerOpen: false
    property date now: new Date()
    readonly property string dayKey: Qt.formatDate(now, "yyyy-MM-dd")
    readonly property var calendarCells: buildCalendar(dayKey)
    readonly property int tabIndex: drawerOpen ? 0 : settingsActive ? 3 : panel.open ? 2 : 1

    readonly property color canvas: Theme.color("canvas", "#f3e6e1")
    readonly property color card: Theme.color("surface", "#fbf1ed")
    readonly property color raised: Theme.color("surfaceRaised", "#f2dcd5")
    readonly property color line: Theme.color("border", "#e9d3cb")
    readonly property color ink: Theme.color("text", "#4a3733")
    readonly property color muted: Theme.color("textMuted", "#a58b84")
    readonly property color accent: Theme.color("accent", "#9a3e33")
    readonly property color accentInk: Theme.color("accentForeground", "#fff4f0")
    readonly property color accentSoft: Theme.color("accentSurface", "#ecc9c1")
    readonly property color accentDeep: Theme.color("accentSurfaceForeground", "#7c2f27")
    readonly property color warm: Theme.color("warning", "#c48a3f")
    readonly property color leaf: Theme.color("update", "#6f9a6a")
    readonly property string uiFont: pickFont(Theme.fontUi)
    readonly property string monoFont: pickFont(Theme.fontMono)

    // Sheet-style deceleration for surfaces that slide into place.
    readonly property var sheetCurve: [0.32, 0.72, 0, 1, 1, 1]

    // 16x16 stroke icons, one path each.
    readonly property var glyphs: ({
            "grid": "M2.5 2.5h4.5v4.5H2.5z M9 2.5h4.5v4.5H9z M2.5 9h4.5v4.5H2.5z M9 9h4.5v4.5H9z",
            "chat": "M3 3h10a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 11H7.5L4.5 13.5V11H3a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 3 3z",
            "changes": "M8 2v6 M5 5h6 M5 12h6",
            "settings": "M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5 M8 1.5v2 M8 12.5v2 M1.5 8h2 M12.5 8h2 M3.4 3.4l1.4 1.4 M11.2 11.2l1.4 1.4 M12.6 3.4l-1.4 1.4 M4.8 11.2l-1.4 1.4",
            "pr": "M4 5.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3z M4 5.5v8 M12 10.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3z M12 10.5V6a2 2 0 0 0-2-2H7.5 M9 2.5L7.5 4L9 5.5",
            "usage": "M2.5 11.5a6 6 0 1 1 11 0 M8 8.5l3-3",
            "palette": "M2.5 3.5L6.5 7.5L2.5 11.5 M8.5 12.5h5",
            "folder": "M2 4h4l1.5 1.5H14v7.5H2z M8 7.5v4 M6 9.5h4",
            "plus": "M8 3v10 M3 8h10",
            "stop": "M4.5 4.5h7v7h-7z",
            "editor": "M5 3.5L1.5 8L5 12.5 M11 3.5L14.5 8L11 12.5",
            "branch": "M4.5 2v12 M11.5 3v2c0 3-7 2-7 5",
            "star": "M8 2l1.8 3.8L14 6.4l-3 2.9.7 4.2L8 11.5l-3.7 2 .7-4.2-3-2.9 4.2-.6z"
        })

    width: 1400
    height: 880
    visible: true
    title: qsTr("T3 Code")
    color: canvas
    opacity: Theme.windowOpacity
    flags: Qt.Window | Qt.FramelessWindowHint

    function pickFont(stack) {
        const installed = Qt.fontFamilies();
        for (const family of stack.split(",")) {
            const name = family.trim();
            if (installed.indexOf(name) >= 0) {
                return name;
            }
        }
        return Qt.application.font.family;
    }

    function isoWeek(date) {
        const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
        return Math.ceil(((utc - yearStart) / 86400000 + 1) / 7);
    }

    // Six Monday-first weeks around the month of `key` (yyyy-MM-dd).
    function buildCalendar(key) {
        const [year, month, day] = key.split("-").map(Number);
        const first = new Date(year, month - 1, 1);
        const start = new Date(year, month - 1, 1 - ((first.getDay() + 6) % 7));
        const cells = [];
        for (let index = 0; index < 42; index += 1) {
            const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
            cells.push({
                day: date.getDate(),
                inMonth: date.getMonth() === month - 1,
                today: date.getMonth() === month - 1 && date.getDate() === day
            });
        }
        return cells;
    }

    function initialOf(name) {
        const trimmed = name.trim();
        return trimmed.length > 0 ? trimmed[0].toUpperCase() : "?";
    }

    onDrawerOpenChanged: if (drawerOpen)
        now = new Date()

    Behavior on sidebarSlot {
        NumberAnimation {
            duration: 240
            easing.type: Easing.BezierSpline
            easing.bezierCurve: root.sheetCurve
        }
    }

    Timer {
        interval: 1000
        running: root.drawerOpen
        repeat: true
        onTriggered: root.now = new Date()
    }

    Shortcut {
        sequence: "Escape"
        enabled: root.drawerOpen
        onActivated: root.drawerOpen = false
    }

    component Card: Rectangle {
        default property alias content: inner.data

        radius: Theme.radius
        color: root.card
        border.color: root.line
        border.width: 1

        Item {
            id: inner

            anchors.fill: parent
            anchors.margins: 1
        }
    }

    component Glyph: Shape {
        id: glyph

        property string kind
        property color tint: root.ink
        property real stroke: 1.5

        width: 16
        height: 16
        preferredRendererType: Shape.CurveRenderer
        Accessible.ignored: true

        ShapePath {
            strokeColor: glyph.tint
            strokeWidth: glyph.stroke
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin

            PathSvg {
                path: root.glyphs[glyph.kind] ?? ""
            }
        }
    }

    // A round rail button: press sinks it, hover tints it, active fills it.
    component RailButton: AbstractButton {
        id: button

        property string kind
        property bool active: false
        property bool round: false

        implicitWidth: 36
        implicitHeight: 36
        hoverEnabled: true
        activeFocusOnTab: true
        Accessible.role: Accessible.Button
        Accessible.name: text

        background: Rectangle {
            radius: button.round ? 18 : 12
            color: button.active ? root.accent : button.hovered || button.visualFocus ? root.accentSoft : button.round ? root.raised : "transparent"
            scale: button.down ? 0.96 : 1

            Behavior on color {
                ColorAnimation {
                    duration: 120
                }
            }

            Behavior on scale {
                NumberAnimation {
                    duration: button.down ? 60 : 140
                    easing.type: Easing.OutQuint
                }
            }
        }

        contentItem: Item {
            Glyph {
                anchors.centerIn: parent
                kind: button.kind
                visible: button.kind.length > 0
                tint: button.active ? root.accentInk : root.accentDeep
            }

            Text {
                anchors.centerIn: parent
                visible: button.kind.length === 0
                text: root.initialOf(button.text)
                color: button.active ? root.accentInk : root.accentDeep
                font.family: root.uiFont
                font.pixelSize: 13
                font.weight: Font.DemiBold
            }
        }

        ToolTip.visible: hovered && text.length > 0
        ToolTip.delay: 500
        ToolTip.text: text
    }

    component NotchTab: AbstractButton {
        id: tab

        property string kind
        property bool active: false

        implicitWidth: 100
        implicitHeight: 46
        hoverEnabled: true
        activeFocusOnTab: true
        Accessible.role: Accessible.Button
        Accessible.name: text

        contentItem: Item {
            Glyph {
                anchors.horizontalCenter: parent.horizontalCenter
                y: 7
                kind: tab.kind
                tint: tab.active ? root.accent : tab.hovered ? root.accentDeep : root.muted

                Behavior on tint {
                    ColorAnimation {
                        duration: 140
                    }
                }
            }

            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                y: 26
                text: tab.text
                color: tab.active ? root.accentDeep : tab.hovered ? root.ink : root.muted
                font.family: root.uiFont
                font.pixelSize: 11
                font.weight: tab.active ? Font.DemiBold : Font.Medium

                Behavior on color {
                    ColorAnimation {
                        duration: 140
                    }
                }
            }
        }
    }

    // A drawer widget. Cards arrive a beat apart when the drawer opens and
    // leave together with it.
    component DashCard: Rectangle {
        id: dash

        property int order: 0
        default property alias content: dashInner.data

        radius: 18
        color: root.card
        border.color: root.line
        border.width: 1

        transform: Translate {
            y: root.drawerOpen ? 0 : 22

            Behavior on y {
                SequentialAnimation {
                    PauseAnimation {
                        duration: root.drawerOpen ? dash.order * 40 : 0
                    }

                    NumberAnimation {
                        duration: root.drawerOpen ? 300 : 160
                        easing.type: Easing.OutQuint
                    }
                }
            }
        }

        Item {
            id: dashInner

            anchors.fill: parent
            anchors.margins: 14
        }
    }

    component Chip: Rectangle {
        id: chip

        property alias text: chipText.text
        property alias kind: chipGlyph.kind
        property color tint: root.accentDeep

        implicitWidth: chipRow.implicitWidth + 16
        implicitHeight: 22
        radius: 11
        color: root.raised

        Row {
            id: chipRow

            anchors.centerIn: parent
            spacing: 5

            Glyph {
                id: chipGlyph

                anchors.verticalCenter: parent.verticalCenter
                width: 12
                height: 12
                scale: 0.75
                visible: kind.length > 0
                tint: chip.tint
            }

            Text {
                id: chipText

                anchors.verticalCenter: parent.verticalCenter
                color: chip.tint
                font.family: root.uiFont
                font.pixelSize: 11
                font.weight: Font.DemiBold
            }
        }
    }

    component Meter: ColumnLayout {
        id: meter

        property int value: 0
        property int peak: 1
        property color tint: root.accent
        property string label

        spacing: 6

        Item {
            Layout.fillHeight: true
            Layout.preferredWidth: 12
            Layout.alignment: Qt.AlignHCenter

            Rectangle {
                anchors.fill: parent
                radius: 6
                color: root.raised
            }

            Rectangle {
                anchors.bottom: parent.bottom
                anchors.left: parent.left
                anchors.right: parent.right
                height: Math.max(12, parent.height * meter.value / Math.max(1, meter.peak))
                radius: 6
                color: meter.value > 0 ? meter.tint : root.line

                Behavior on height {
                    NumberAnimation {
                        duration: 300
                        easing.type: Easing.OutQuint
                    }
                }

                Behavior on color {
                    ColorAnimation {
                        duration: 160
                    }
                }
            }
        }

        Text {
            Layout.alignment: Qt.AlignHCenter
            text: meter.value
            color: root.ink
            font.family: root.uiFont
            font.pixelSize: 12
            font.weight: Font.DemiBold
        }

        Text {
            Layout.fillWidth: true
            text: meter.label
            color: root.muted
            elide: Text.ElideRight
            horizontalAlignment: Text.AlignHCenter
            font.family: root.uiFont
            font.pixelSize: 9
            font.letterSpacing: 0.4
            font.capitalization: Font.AllUppercase
        }
    }

    Rectangle {
        anchors.fill: parent

        gradient: Gradient {
            GradientStop {
                position: 0
                color: Qt.lighter(root.canvas, 1.02)
            }

            GradientStop {
                position: 1
                color: Qt.darker(root.canvas, 1.04)
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 14
        spacing: 12

        // Top strip: the title pill spans the rail and sidebar columns and
        // shrinks with the sidebar; the workspace strip takes the rest.
        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: false
            Layout.preferredHeight: 44
            spacing: 12

            Card {
                Layout.preferredWidth: Math.max(208, 64 + root.sidebarSlot)
                Layout.fillHeight: true

                TitleBar {
                    anchors.fill: parent
                    window: root
                    color: "transparent"
                }
            }

            Card {
                Layout.fillWidth: true
                Layout.fillHeight: true

                Workspace {
                    anchors.fill: parent
                    visible: ready
                    clip: true
                    sidebarToggle: root.sidebarCollapsed
                    color: "transparent"
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 12

            // The rail: dashboard toggle, project scope, and the app's places.
            Card {
                Layout.preferredWidth: 52
                Layout.fillHeight: true

                ColumnLayout {
                    anchors.fill: parent
                    anchors.topMargin: 10
                    anchors.bottomMargin: 10
                    spacing: 6

                    RailButton {
                        Layout.alignment: Qt.AlignHCenter
                        kind: "grid"
                        text: qsTr("Dashboard")
                        active: root.drawerOpen
                        onClicked: root.drawerOpen = !root.drawerOpen
                    }

                    Rectangle {
                        Layout.alignment: Qt.AlignHCenter
                        Layout.topMargin: 4
                        Layout.bottomMargin: 4
                        width: 18
                        height: 1
                        color: root.line
                    }

                    RailButton {
                        Layout.alignment: Qt.AlignHCenter
                        round: true
                        kind: "star"
                        text: qsTr("All projects")
                        active: root.sidebarState !== null && root.scopeKey === null
                        onClicked: Shell.dispatch("sidebar.scope", {
                            "projectKey": null
                        })
                    }

                    Repeater {
                        model: root.projects

                        RailButton {
                            required property var modelData

                            Layout.alignment: Qt.AlignHCenter
                            round: true
                            text: modelData.displayName
                            active: root.scopeKey === modelData.key
                            onClicked: Shell.dispatch("sidebar.scope", {
                                "projectKey": modelData.key
                            })
                        }
                    }

                    RailButton {
                        Layout.alignment: Qt.AlignHCenter
                        kind: "plus"
                        text: qsTr("New thread")
                        enabled: root.projects.length > 0
                        opacity: enabled ? 1 : 0.4
                        onClicked: Shell.dispatch("thread.new", root.scopeKey !== null ? {
                            "projectKey": root.scopeKey
                        } : {})
                    }

                    Item {
                        Layout.fillHeight: true
                    }

                    RailButton {
                        Layout.alignment: Qt.AlignHCenter
                        kind: "pr"
                        text: qsTr("Pull requests")
                        onClicked: Shell.dispatch("pullRequests.open")
                    }

                    RailButton {
                        Layout.alignment: Qt.AlignHCenter
                        kind: "usage"
                        text: qsTr("Usage")
                        onClicked: Shell.dispatch("usage.open")
                    }

                    RailButton {
                        Layout.alignment: Qt.AlignHCenter
                        kind: "palette"
                        text: qsTr("Command palette")
                        onClicked: Shell.dispatch("palette.open")
                    }

                    RailButton {
                        Layout.alignment: Qt.AlignHCenter
                        kind: "folder"
                        text: qsTr("Add project")
                        onClicked: Shell.dispatch("project.add")
                    }
                }
            }

            Card {
                Layout.preferredWidth: root.sidebarSlot
                Layout.minimumWidth: 0
                Layout.fillHeight: true
                visible: root.sidebarSlot > 0
                clip: true

                Sidebar {
                    anchors.fill: parent
                    visible: !root.settingsActive
                    showScope: false
                    showFooter: false
                    color: "transparent"
                }

                SettingsNav {
                    anchors.fill: parent
                    visible: root.settingsActive
                    color: "transparent"
                }
            }

            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 12

                // The page, with a band at the top for the notch to hang from.
                Card {
                    id: surfaceCard

                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true

                    WebSurface {
                        anchors.fill: parent
                        anchors.topMargin: 54
                        url: Shell.pageUrl
                    }

                    MouseArea {
                        anchors.fill: parent
                        visible: root.drawerOpen
                        onClicked: root.drawerOpen = false
                    }

                    // The drawer settles in from just above its resting spot
                    // and leaves faster than it came.
                    Item {
                        id: drawer

                        anchors.top: parent.top
                        anchors.topMargin: 58
                        anchors.horizontalCenter: parent.horizontalCenter
                        width: Math.min(parent.width - 24, 980)
                        height: 336
                        visible: opacity > 0
                        opacity: root.drawerOpen ? 1 : 0

                        Behavior on opacity {
                            OpacityAnimator {
                                duration: root.drawerOpen ? 200 : 140
                            }
                        }

                        transform: [
                            Scale {
                                origin.x: drawer.width / 2
                                origin.y: 0
                                xScale: root.drawerOpen ? 1 : 0.97
                                yScale: xScale

                                Behavior on xScale {
                                    NumberAnimation {
                                        duration: root.drawerOpen ? 320 : 200
                                        easing.type: Easing.BezierSpline
                                        easing.bezierCurve: root.sheetCurve
                                    }
                                }
                            },
                            Translate {
                                y: root.drawerOpen ? 0 : -12

                                Behavior on y {
                                    NumberAnimation {
                                        duration: root.drawerOpen ? 320 : 200
                                        easing.type: Easing.BezierSpline
                                        easing.bezierCurve: root.sheetCurve
                                    }
                                }
                            }
                        ]

                        Rectangle {
                            anchors.fill: parent
                            anchors.topMargin: 6
                            radius: 24
                            color: Qt.rgba(root.accentDeep.r, root.accentDeep.g, root.accentDeep.b, 0.12)
                        }

                        Rectangle {
                            anchors.fill: parent
                            radius: 22
                            color: root.canvas
                            border.color: root.line
                            border.width: 1

                            MouseArea {
                                anchors.fill: parent
                            }
                        }

                        RowLayout {
                            anchors.fill: parent
                            anchors.margins: 12
                            spacing: 10

                            ColumnLayout {
                                Layout.preferredWidth: 196
                                Layout.maximumWidth: 196
                                Layout.fillWidth: false
                                Layout.fillHeight: true
                                spacing: 10

                                // Where you are: project, thread, branch, git.
                                DashCard {
                                    Layout.fillWidth: true
                                    Layout.preferredHeight: 108
                                    order: 0

                                    ColumnLayout {
                                        anchors.fill: parent
                                        spacing: 4

                                        Text {
                                            Layout.fillWidth: true
                                            text: root.workspace && root.workspace.projectTitle ? root.workspace.projectTitle : qsTr("No thread open")
                                            color: root.ink
                                            elide: Text.ElideRight
                                            font.family: root.uiFont
                                            font.pixelSize: 14
                                            font.weight: Font.Bold
                                        }

                                        Text {
                                            Layout.fillWidth: true
                                            text: root.workspace ? root.workspace.threadTitle : qsTr("Pick one in the sidebar")
                                            color: root.muted
                                            elide: Text.ElideRight
                                            font.family: root.uiFont
                                            font.pixelSize: 11
                                        }

                                        Item {
                                            Layout.fillHeight: true
                                        }

                                        Flow {
                                            Layout.fillWidth: true
                                            spacing: 6

                                            Chip {
                                                visible: root.workspace !== null && root.workspace.branch !== null
                                                kind: "branch"
                                                text: root.workspace && root.workspace.branch ? root.workspace.branch : ""
                                            }

                                            Chip {
                                                visible: root.git !== null && root.git.hasUpstream && (root.git.aheadCount > 0 || root.git.behindCount > 0)
                                                text: root.git ? "↑%1 ↓%2".arg(root.git.aheadCount).arg(root.git.behindCount) : ""
                                                tint: root.warm
                                            }

                                            Chip {
                                                visible: root.git !== null && root.git.hasWorkingTreeChanges
                                                kind: "changes"
                                                text: qsTr("Edits")
                                                tint: root.leaf
                                            }

                                            Chip {
                                                visible: root.git !== null && root.git.pullRequest !== null
                                                kind: "pr"
                                                text: root.git && root.git.pullRequest ? "#" + root.git.pullRequest.number : ""
                                            }
                                        }
                                    }
                                }

                                // Today, in the big numerals the rail deserves.
                                DashCard {
                                    Layout.fillWidth: true
                                    Layout.fillHeight: true
                                    order: 1

                                    ColumnLayout {
                                        anchors.centerIn: parent
                                        spacing: 0

                                        Text {
                                            Layout.alignment: Qt.AlignHCenter
                                            text: Qt.formatDate(root.now, "dd")
                                            color: root.accentDeep
                                            font.family: root.uiFont
                                            font.pixelSize: 44
                                            font.weight: Font.Bold
                                            font.letterSpacing: -1
                                            lineHeight: 0.9
                                        }

                                        Row {
                                            Layout.alignment: Qt.AlignHCenter
                                            spacing: 4

                                            Repeater {
                                                model: 3

                                                Rectangle {
                                                    width: 4
                                                    height: 4
                                                    radius: 2
                                                    color: root.accent
                                                }
                                            }
                                        }

                                        Text {
                                            Layout.alignment: Qt.AlignHCenter
                                            text: Qt.formatDate(root.now, "MM")
                                            color: root.accentDeep
                                            font.family: root.uiFont
                                            font.pixelSize: 44
                                            font.weight: Font.Bold
                                            font.letterSpacing: -1
                                            lineHeight: 0.9
                                        }

                                        Text {
                                            Layout.alignment: Qt.AlignHCenter
                                            Layout.topMargin: 6
                                            text: qsTr("%1, wk %2").arg(Qt.formatDate(root.now, "ddd")).arg(root.isoWeek(root.now))
                                            color: root.muted
                                            font.family: root.uiFont
                                            font.pixelSize: 11
                                            font.weight: Font.Medium
                                        }

                                        Text {
                                            Layout.alignment: Qt.AlignHCenter
                                            Layout.topMargin: 2
                                            text: Qt.formatTime(root.now, "HH:mm")
                                            color: root.ink
                                            font.family: root.monoFont
                                            font.pixelSize: 12
                                        }
                                    }
                                }
                            }

                            // The month, today circled.
                            DashCard {
                                Layout.preferredWidth: 292
                                Layout.fillHeight: true
                                order: 2

                                ColumnLayout {
                                    anchors.fill: parent
                                    spacing: 6

                                    Text {
                                        Layout.alignment: Qt.AlignHCenter
                                        text: Qt.formatDate(root.now, "MMMM yyyy")
                                        color: root.accentDeep
                                        font.family: root.uiFont
                                        font.pixelSize: 12
                                        font.weight: Font.Bold
                                        font.letterSpacing: 0.4
                                    }

                                    GridLayout {
                                        Layout.fillWidth: true
                                        Layout.fillHeight: true
                                        columns: 7
                                        rowSpacing: 0
                                        columnSpacing: 0

                                        Repeater {
                                            model: 7

                                            Text {
                                                required property int index

                                                Layout.fillWidth: true
                                                text: Qt.locale().dayName(index === 6 ? 7 : index + 1, Locale.ShortFormat)
                                                color: root.accentDeep
                                                horizontalAlignment: Text.AlignHCenter
                                                font.family: root.uiFont
                                                font.pixelSize: 10
                                                font.weight: Font.DemiBold
                                            }
                                        }

                                        Repeater {
                                            model: root.calendarCells

                                            Item {
                                                required property var modelData

                                                Layout.fillWidth: true
                                                Layout.fillHeight: true

                                                Rectangle {
                                                    anchors.centerIn: parent
                                                    width: 24
                                                    height: 24
                                                    radius: 12
                                                    color: root.accent
                                                    visible: parent.modelData.today
                                                }

                                                Text {
                                                    anchors.centerIn: parent
                                                    text: parent.modelData.day
                                                    color: parent.modelData.today ? root.accentInk : parent.modelData.inMonth ? root.ink : root.line
                                                    font.family: root.uiFont
                                                    font.pixelSize: 11
                                                    font.weight: parent.modelData.today ? Font.Bold : Font.Medium
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            // Thread meters: what is moving, what is waiting on you.
                            DashCard {
                                Layout.preferredWidth: 224
                                Layout.fillHeight: true
                                order: 3

                                RowLayout {
                                    anchors.fill: parent
                                    anchors.topMargin: 4
                                    spacing: 4

                                    Meter {
                                        Layout.fillWidth: true
                                        Layout.fillHeight: true
                                        label: qsTr("Active")
                                        value: root.threadCount
                                        peak: root.meterPeak
                                        tint: root.accent
                                    }

                                    Meter {
                                        Layout.fillWidth: true
                                        Layout.fillHeight: true
                                        label: qsTr("Waiting")
                                        value: root.attentionCount
                                        peak: Math.max(1, root.attentionCount)
                                        tint: root.warm
                                    }

                                    Meter {
                                        Layout.fillWidth: true
                                        Layout.fillHeight: true
                                        label: qsTr("Snoozed")
                                        value: root.sidebarState ? root.sidebarState.snoozed.length : 0
                                        peak: root.meterPeak
                                        tint: root.muted
                                    }

                                    Meter {
                                        Layout.fillWidth: true
                                        Layout.fillHeight: true
                                        label: qsTr("Settled")
                                        value: root.sidebarState ? root.sidebarState.settledTotal : 0
                                        peak: root.meterPeak
                                        tint: root.leaf
                                    }
                                }
                            }

                            // The agent behind the composer, and its transport controls.
                            DashCard {
                                Layout.preferredWidth: 200
                                Layout.minimumWidth: 160
                                Layout.fillWidth: true
                                Layout.fillHeight: true
                                order: 4

                                ColumnLayout {
                                    anchors.fill: parent
                                    spacing: 6

                                    Item {
                                        Layout.alignment: Qt.AlignHCenter
                                        Layout.preferredWidth: 88
                                        Layout.preferredHeight: 88

                                        Rectangle {
                                            anchors.fill: parent
                                            radius: 44
                                            color: root.accentSoft
                                        }

                                        Rectangle {
                                            anchors.fill: parent
                                            anchors.margins: 5
                                            radius: 39
                                            color: root.raised

                                            Text {
                                                anchors.centerIn: parent
                                                text: root.instance ? root.initialOf(root.instance.displayName) : "T3"
                                                color: root.accentDeep
                                                font.family: root.uiFont
                                                font.pixelSize: 30
                                                font.weight: Font.Bold
                                            }
                                        }

                                        Rectangle {
                                            anchors.right: parent.right
                                            anchors.bottom: parent.bottom
                                            width: 18
                                            height: 18
                                            radius: 9
                                            color: root.card
                                            border.color: root.line
                                            border.width: 1

                                            Rectangle {
                                                anchors.centerIn: parent
                                                width: 10
                                                height: 10
                                                radius: 5
                                                color: root.attentionCount > 0 ? root.warm : root.composerReady && root.composerState.isRunning ? root.accent : root.leaf

                                                Behavior on color {
                                                    ColorAnimation {
                                                        duration: 160
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    Text {
                                        Layout.fillWidth: true
                                        Layout.topMargin: 4
                                        text: root.composerReady && root.composerState.selectedModel ? root.composerState.selectedModel : qsTr("No model picked")
                                        color: root.accent
                                        horizontalAlignment: Text.AlignHCenter
                                        elide: Text.ElideMiddle
                                        font.family: root.uiFont
                                        font.pixelSize: 13
                                        font.weight: Font.Bold
                                    }

                                    Text {
                                        Layout.fillWidth: true
                                        text: root.instance ? root.instance.displayName : qsTr("Open a thread to pick an agent")
                                        color: root.ink
                                        horizontalAlignment: Text.AlignHCenter
                                        elide: Text.ElideRight
                                        font.family: root.uiFont
                                        font.pixelSize: 11
                                    }

                                    Text {
                                        Layout.fillWidth: true
                                        text: {
                                            if (!root.composerReady) {
                                                return "";
                                            }
                                            if (root.attentionCount > 0) {
                                                return qsTr("%n request(s) waiting on you", "", root.attentionCount);
                                            }
                                            if (root.composerState.isRunning) {
                                                return qsTr("Working");
                                            }
                                            return root.composerState.runtimeMode.length > 0 ? root.composerState.runtimeMode : qsTr("Ready");
                                        }
                                        color: root.attentionCount > 0 ? root.warm : root.muted
                                        horizontalAlignment: Text.AlignHCenter
                                        elide: Text.ElideRight
                                        font.family: root.uiFont
                                        font.pixelSize: 11
                                        font.weight: Font.Medium
                                    }

                                    Item {
                                        Layout.fillHeight: true
                                    }

                                    RowLayout {
                                        Layout.alignment: Qt.AlignHCenter
                                        spacing: 10

                                        RailButton {
                                            round: true
                                            kind: "plus"
                                            text: qsTr("New thread")
                                            enabled: root.workspace !== null
                                            opacity: enabled ? 1 : 0.4
                                            onClicked: {
                                                Shell.dispatch("workspace.newThread");
                                                root.drawerOpen = false;
                                            }
                                        }

                                        RailButton {
                                            round: true
                                            kind: "stop"
                                            text: qsTr("Stop the agent")
                                            active: true
                                            enabled: root.composerReady && root.composerState.isRunning
                                            opacity: enabled ? 1 : 0.4
                                            onClicked: Shell.dispatch("composer.interrupt")
                                        }

                                        RailButton {
                                            round: true
                                            kind: "editor"
                                            text: qsTr("Open in editor")
                                            enabled: root.workspace !== null && root.workspace.editors.length > 0
                                            opacity: enabled ? 1 : 0.4
                                            onClicked: Shell.dispatch("workspace.openInEditor", {})
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // The notch: four tabs on a pill hanging from the top edge,
                    // the active one carried by a sliding plate.
                    Rectangle {
                        id: notch

                        readonly property Item activeTab: tabRow.children[root.tabIndex] ?? null

                        anchors.top: parent.top
                        anchors.horizontalCenter: parent.horizontalCenter
                        width: tabRow.width + 12
                        height: 50
                        color: root.raised
                        bottomLeftRadius: 20
                        bottomRightRadius: 20

                        Rectangle {
                            x: tabRow.x + (notch.activeTab ? notch.activeTab.x : 0)
                            y: 4
                            width: notch.activeTab ? notch.activeTab.width : 0
                            height: notch.height - 8
                            radius: 16
                            color: root.card

                            Behavior on x {
                                NumberAnimation {
                                    duration: 260
                                    easing.type: Easing.OutQuint
                                }
                            }
                        }

                        Row {
                            id: tabRow

                            anchors.horizontalCenter: parent.horizontalCenter
                            anchors.verticalCenter: parent.verticalCenter

                            NotchTab {
                                kind: "grid"
                                text: qsTr("Dashboard")
                                active: root.tabIndex === 0
                                onClicked: root.drawerOpen = !root.drawerOpen
                            }

                            NotchTab {
                                kind: "chat"
                                text: qsTr("Chat")
                                active: root.tabIndex === 1
                                onClicked: {
                                    root.drawerOpen = false;
                                    if (root.settingsActive) {
                                        Shell.dispatch("settings.back");
                                    }
                                }
                            }

                            NotchTab {
                                kind: "changes"
                                text: qsTr("Changes")
                                active: root.tabIndex === 2
                                onClicked: {
                                    root.drawerOpen = false;
                                    Shell.dispatch("rightPanel.toggle");
                                }
                            }

                            NotchTab {
                                kind: "settings"
                                text: qsTr("Settings")
                                active: root.tabIndex === 3
                                onClicked: {
                                    root.drawerOpen = false;
                                    Shell.dispatch("settings.open");
                                }
                            }
                        }
                    }
                }

                Card {
                    Layout.fillWidth: true
                    Layout.preferredHeight: composer.implicitHeight
                    visible: composer.ready

                    Composer {
                        id: composer

                        anchors.fill: parent
                        color: "transparent"
                    }
                }
            }

            Card {
                Layout.preferredWidth: panel.implicitWidth
                Layout.fillHeight: true
                visible: panel.available && panel.open

                RightPanel {
                    id: panel

                    anchors.fill: parent
                    color: "transparent"
                }
            }
        }
    }

    Notifications {
        anchors.bottom: parent.bottom
        anchors.right: parent.right
        anchors.margins: 24
    }

    ContextMenuHost {
        surfaceId: "shell"
    }

    ShellErrorOverlay {
        anchors.fill: parent
    }
}
