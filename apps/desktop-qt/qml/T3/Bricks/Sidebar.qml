import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import T3.Shell

// The thread sidebar, rendered from the view model the web app publishes
// under Shell.state.sidebar (see packages/contracts/src/shell.ts). Every
// click is dispatched back to the page; nothing here talks to the server.
Rectangle {
    id: sidebar

    readonly property var model: Shell.state.sidebar ?? null
    // A rice that puts project scope and the app's places elsewhere (an icon
    // rail, say) turns these off so the brick is just the thread list.
    property bool showScope: true
    property bool showFooter: true
    // The brand band ("T3 Code" plus the collapse toggle) is what the page
    // shows above its sidebar; a rice with its own title bar leaves it off.
    // When frameless it doubles as the window's drag handle.
    property bool showBrand: false
    property Window window: null
    readonly property var projects: model ? model.projects : []
    readonly property var projectNames: {
        const names = {};
        for (const project of projects) {
            names[project.key] = project.displayName;
        }
        return names;
    }
    readonly property string scopeLabel: {
        if (!model || model.scopeProjectKey === null) {
            return qsTr("All projects");
        }
        return projectNames[model.scopeProjectKey] ?? qsTr("All projects");
    }
    property var collapsed: ({})
    readonly property var rows: buildRows(model, collapsed)
    readonly property color foreground: Theme.color("sidebarForeground", "#e4e4e7")
    readonly property color muted: Theme.color("sidebarMutedForeground", "#8b8b93")
    readonly property color iconColor: Theme.color("iconMuted", "#8b8b93")
    readonly property color hairline: Theme.color("sidebarBorder", "#27272a")

    implicitWidth: 256
    color: Theme.color("sidebar", "#0a0a0a")
    // Content keeps its width while the shell animates ours.
    clip: true

    function toggleSection(key) {
        const next = Object.assign({}, collapsed);
        next[key] = !next[key];
        collapsed = next;
    }

    function buildRows(state, folded) {
        if (!state) {
            return [];
        }
        const out = [];
        for (const draft of state.drafts) {
            out.push({
                kind: "draft",
                section: "draft",
                rowKey: "draft:" + draft.draftId,
                item: draft
            });
        }
        for (const item of state.pinned) {
            out.push({
                kind: "thread",
                section: "pinned",
                rowKey: item.key,
                item: item
            });
        }
        if (state.pinned.length > 0 && state.active.length > 0) {
            out.push({
                kind: "divider"
            });
        }
        for (const item of state.active) {
            out.push({
                kind: "thread",
                section: "active",
                rowKey: item.key,
                item: item
            });
        }
        const section = (key, label, items) => {
            if (items.length === 0) {
                return;
            }
            const open = !folded[key];
            out.push({
                kind: "header",
                key: key,
                rowKey: "header:" + key,
                label: label,
                count: items.length,
                open: open
            });
            if (!open) {
                return;
            }
            for (const item of items) {
                out.push({
                    kind: "slim",
                    section: key,
                    rowKey: item.key,
                    item: item
                });
            }
        };
        section("snoozed", qsTr("Snoozed"), state.snoozed);
        section("settled", qsTr("Settled"), state.settled);
        if (!folded.settled && state.settledTotal > state.settled.length) {
            out.push({
                kind: "note",
                label: qsTr("%1 more settled in the app").arg(state.settledTotal - state.settled.length)
            });
        }
        return out;
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: Math.min(0, sidebar.width - sidebar.implicitWidth)
        spacing: 0

        // Brand band: sidebar toggle and wordmark.
        Item {
            Layout.fillWidth: true
            Layout.preferredHeight: 52
            visible: sidebar.showBrand

            DragHandler {
                enabled: sidebar.window !== null && Theme.frameless
                target: null
                grabPermissions: PointerHandler.CanTakeOverFromAnything
                onActiveChanged: if (active)
                    sidebar.window.startSystemMove()
            }

            ShellButton {
                x: 12
                y: 12
                subtle: true
                implicitHeight: 28
                iconName: "panel-left-close"
                iconSize: 16
                iconTint: sidebar.iconColor
                Accessible.name: qsTr("Hide sidebar")
                onClicked: Shell.dispatch("sidebar.toggle")
            }

            Row {
                x: 52
                anchors.verticalCenter: parent.verticalCenter
                spacing: 6

                T3Wordmark {
                    size: 10
                    color: sidebar.foreground
                    anchors.verticalCenter: parent.verticalCenter
                }

                Text {
                    text: qsTr("Code")
                    color: sidebar.muted
                    font.pixelSize: 14
                    font.weight: Font.Medium
                    font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                    anchors.verticalCenter: parent.verticalCenter
                }
            }
        }

        // Search + new thread, scope + add project.
        ColumnLayout {
            Layout.fillWidth: true
            Layout.margins: 8
            spacing: 4
            visible: sidebar.showScope

            RowLayout {
                Layout.fillWidth: true
                spacing: 4

                ShellButton {
                    Layout.fillWidth: true
                    implicitHeight: 32
                    subtle: true
                    iconName: "search"
                    iconSize: 16
                    iconTint: Qt.alpha(sidebar.muted, 0.8)
                    tint: sidebar.foreground
                    text: qsTr("Search")
                    font.pixelSize: 14
                    onClicked: Shell.dispatch("palette.open")

                    background: Rectangle {
                        radius: 8
                        color: parent.hovered || parent.down ? Theme.color("sidebarRowHover", "#1c1c21") : Theme.color("sidebarControlSurface", "#141416")

                        Behavior on color {
                            ColorAnimation {
                                duration: 120
                            }
                        }
                    }
                }

                ShellButton {
                    subtle: true
                    implicitHeight: 32
                    iconName: "square-pen"
                    iconSize: 16
                    iconTint: sidebar.iconColor
                    Accessible.name: qsTr("New thread")
                    onClicked: Shell.dispatch("thread.new", sidebar.model && sidebar.model.scopeProjectKey !== null ? {
                        projectKey: sidebar.model.scopeProjectKey
                    } : {})
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 4

                ShellButton {
                    id: scopeButton

                    Layout.fillWidth: true
                    implicitHeight: 32
                    leftPadding: 9
                    subtle: true
                    chevron: true
                    chevronSize: 16
                    iconName: "folder"
                    iconSize: 16
                    iconTint: Qt.alpha(sidebar.muted, 0.8)
                    tint: Qt.alpha(sidebar.muted, 0.8)
                    text: sidebar.scopeLabel
                    font.pixelSize: 14
                    Accessible.name: qsTr("Project scope")
                    onClicked: scopeMenu.open()

                    ShellMenu {
                        id: scopeMenu

                        y: parent.height + 4
                        width: Math.max(parent.width, 200)

                        ShellMenuItem {
                            text: qsTr("All projects")
                            current: sidebar.model !== null && sidebar.model.scopeProjectKey === null
                            onTriggered: Shell.dispatch("sidebar.scope", {
                                projectKey: null
                            })
                        }

                        Instantiator {
                            model: sidebar.projects

                            delegate: ShellMenuItem {
                                required property var modelData

                                text: modelData.displayName
                                iconName: "folder"
                                current: sidebar.model !== null && sidebar.model.scopeProjectKey === modelData.key
                                onTriggered: Shell.dispatch("sidebar.scope", {
                                    projectKey: modelData.key
                                })
                            }

                            onObjectAdded: (index, object) => scopeMenu.insertItem(index + 1, object)
                            onObjectRemoved: (index, object) => scopeMenu.removeItem(object)
                        }
                    }
                }

                ShellButton {
                    subtle: true
                    implicitHeight: 32
                    iconName: "folder-plus"
                    iconSize: 16
                    iconTint: sidebar.iconColor
                    Accessible.name: qsTr("Add project")
                    onClicked: Shell.dispatch("project.add")
                }
            }
        }

        ListView {
            id: list

            // The keyboard cursor, by row key so it survives the list being
            // rebuilt around it. Up/Down/Home/End move it over the rows that
            // can be acted on, Enter opens (or folds) the row, Menu or
            // Shift+F10 opens its context menu.
            property string cursorKey: ""
            readonly property int cursorIndex: sidebar.rows.findIndex(r => r.rowKey !== undefined && r.rowKey === list.cursorKey)

            function moveCursor(delta) {
                let i = cursorIndex;
                do {
                    i += delta;
                    if (i < 0 || i >= sidebar.rows.length) {
                        return;
                    }
                } while (sidebar.rows[i].rowKey === undefined);
                cursorKey = sidebar.rows[i].rowKey;
                positionViewAtIndex(i, ListView.Contain);
            }

            function moveCursorToEdge(delta) {
                const rows = sidebar.rows;
                for (let i = delta > 0 ? 0 : rows.length - 1; i >= 0 && i < rows.length; i += delta) {
                    if (rows[i].rowKey !== undefined) {
                        cursorKey = rows[i].rowKey;
                        positionViewAtIndex(i, ListView.Contain);
                        return;
                    }
                }
            }

            function settleCursor() {
                if (cursorIndex >= 0) {
                    return;
                }
                const current = sidebar.rows.find(r => r.rowKey !== undefined && sidebar.model !== null && (r.kind === "draft" ? r.item.draftId === sidebar.model.activeDraftId : r.kind !== "header" && r.item.key === sidebar.model.activeThreadKey));
                const first = current ?? sidebar.rows.find(r => r.rowKey !== undefined);
                cursorKey = first ? first.rowKey : "";
            }

            function activateCursor() {
                const row = sidebar.rows[cursorIndex];
                if (!row) {
                    return;
                }
                switch (row.kind) {
                case "header":
                    sidebar.toggleSection(row.key);
                    break;
                case "draft":
                    Shell.dispatch("draft.open", {
                        draftId: row.item.draftId
                    });
                    break;
                default:
                    Shell.dispatch("thread.open", {
                        key: row.item.key
                    });
                }
            }

            function menuAtCursor() {
                const row = sidebar.rows[cursorIndex];
                const item = itemAtIndex(cursorIndex);
                if (!row || !item || row.kind === "header" || row.kind === "draft") {
                    return;
                }
                const p = item.mapToItem(null, item.width / 2, item.height / 2);
                Shell.dispatch("thread.menu", {
                    key: row.item.key,
                    x: p.x,
                    y: p.y
                });
            }

            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.leftMargin: 9
            Layout.rightMargin: 8
            Layout.bottomMargin: 4
            clip: true
            model: sidebar.rows
            reuseItems: true
            spacing: 1
            boundsBehavior: Flickable.StopAtBounds
            activeFocusOnTab: true
            keyNavigationEnabled: false
            Accessible.role: Accessible.List
            Accessible.name: qsTr("Threads")
            onActiveFocusChanged: {
                if (activeFocus) {
                    settleCursor();
                }
            }
            Keys.onUpPressed: moveCursor(-1)
            Keys.onDownPressed: moveCursor(1)
            Keys.onPressed: event => {
                switch (event.key) {
                case Qt.Key_Home:
                    moveCursorToEdge(1);
                    break;
                case Qt.Key_End:
                    moveCursorToEdge(-1);
                    break;
                case Qt.Key_Return:
                case Qt.Key_Enter:
                case Qt.Key_Space:
                    activateCursor();
                    break;
                case Qt.Key_Menu:
                    menuAtCursor();
                    break;
                case Qt.Key_F10:
                    if (!(event.modifiers & Qt.ShiftModifier)) {
                        return;
                    }
                    menuAtCursor();
                    break;
                default:
                    return;
                }
                event.accepted = true;
            }

            delegate: Item {
                id: entry

                required property var modelData

                readonly property string kind: modelData.kind
                readonly property bool focused: list.activeFocus && modelData.rowKey !== undefined && modelData.rowKey === list.cursorKey

                width: ListView.view.width
                implicitHeight: kind === "header" ? 36 : kind === "divider" ? 13 : kind === "note" ? 28 : kind === "slim" ? 36 : 82

                // Collapsible section header with a hairline (settled) or tint (snoozed).
                Item {
                    anchors.fill: parent
                    visible: entry.kind === "header"

                    Rectangle {
                        anchors.fill: parent
                        radius: 8
                        color: "transparent"
                        border.width: 1
                        border.color: Theme.color("focus", "#3b82f6")
                        visible: entry.focused
                    }

                    HoverHandler {
                        id: headerHover
                    }

                    TapHandler {
                        onTapped: sidebar.toggleSection(entry.modelData.key)
                    }

                    RowLayout {
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.bottom: parent.bottom
                        anchors.leftMargin: 10
                        anchors.rightMargin: 10
                        anchors.bottomMargin: 4
                        height: 20
                        spacing: 8

                        Text {
                            text: entry.kind === "header" ? entry.modelData.label : ""
                            color: entry.kind === "header" && entry.modelData.key === "snoozed" ? Theme.color("info", "#60a5fa") : Qt.alpha(sidebar.muted, headerHover.hovered ? 0.8 : 0.5)
                            font.pixelSize: 12
                            font.weight: Font.Medium
                            font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                        }

                        Rectangle {
                            Layout.fillWidth: true
                            implicitHeight: 1
                            color: Qt.alpha(sidebar.hairline, 0.6)
                            visible: entry.kind === "header" && entry.modelData.key === "settled"
                        }

                        Item {
                            Layout.fillWidth: true
                            visible: !(entry.kind === "header" && entry.modelData.key === "settled")
                        }

                        Text {
                            visible: entry.kind === "header" && !entry.modelData.open
                            text: entry.kind === "header" ? entry.modelData.count : ""
                            color: Qt.alpha(sidebar.muted, 0.5)
                            font.pixelSize: 12
                            font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                        }

                        ShellIcon {
                            name: "chevron-down"
                            size: 12
                            color: Qt.alpha(sidebar.muted, 0.5)
                            rotation: entry.kind === "header" && entry.modelData.open ? 0 : -90
                            Layout.alignment: Qt.AlignVCenter

                            Behavior on rotation {
                                NumberAnimation {
                                    duration: 150
                                    easing.type: Easing.OutCubic
                                }
                            }
                        }
                    }
                }

                Rectangle {
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: 10
                    anchors.rightMargin: 10
                    height: 1
                    visible: entry.kind === "divider"
                    color: Qt.alpha(sidebar.hairline, 0.6)
                }

                Text {
                    anchors.centerIn: parent
                    visible: entry.kind === "note"
                    text: entry.kind === "note" ? entry.modelData.label : ""
                    color: Qt.alpha(sidebar.muted, 0.6)
                    font.pixelSize: 12
                    font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
                }

                Loader {
                    anchors.fill: parent
                    anchors.topMargin: entry.kind === "thread" ? 2 : 0
                    anchors.bottomMargin: entry.kind === "thread" ? 2 : 0
                    active: entry.kind === "thread" || entry.kind === "slim" || entry.kind === "draft"

                    sourceComponent: SidebarThreadRow {
                        slim: entry.kind !== "thread"
                        section: entry.modelData.section
                        focused: entry.focused
                        item: entry.kind === "draft" ? {
                            title: entry.modelData.item.label,
                            status: "ready",
                            statusLabel: null,
                            unread: false,
                            branch: null,
                            updatedAt: null
                        } : entry.modelData.item
                        projectName: sidebar.projectNames[entry.modelData.item.projectKey] ?? ""
                        active: sidebar.model !== null && (entry.kind === "draft" ? entry.modelData.item.draftId === sidebar.model.activeDraftId : entry.modelData.item.key === sidebar.model.activeThreadKey)
                        onActivated: {
                            list.cursorKey = entry.modelData.rowKey;
                            if (entry.kind === "draft") {
                                Shell.dispatch("draft.open", {
                                    draftId: entry.modelData.item.draftId
                                });
                            } else {
                                Shell.dispatch("thread.open", {
                                    key: entry.modelData.item.key
                                });
                            }
                        }
                        onMenuRequested: (windowX, windowY) => {
                            if (entry.kind !== "draft") {
                                Shell.dispatch("thread.menu", {
                                    key: entry.modelData.item.key,
                                    x: windowX,
                                    y: windowY
                                });
                            }
                        }
                        onSettleRequested: Shell.dispatch("thread.settle", {
                            key: entry.modelData.item.key
                        })
                        onUnsettleRequested: Shell.dispatch("thread.unsettle", {
                            key: entry.modelData.item.key
                        })
                        onUnsnoozeRequested: Shell.dispatch("thread.unsnooze", {
                            key: entry.modelData.item.key
                        })
                        onSnoozeRequested: (windowX, windowY) => Shell.dispatch("thread.snoozeMenu", {
                            key: entry.modelData.item.key,
                            x: windowX,
                            y: windowY
                        })
                        onWokeDismissed: Shell.dispatch("thread.wokeDismiss", {
                            key: entry.modelData.item.key
                        })
                    }
                }
            }

            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                y: 24
                visible: list.count === 0
                text: sidebar.model === null ? qsTr("Waiting for the app…") : sidebar.projects.length === 0 ? qsTr("No projects yet") : qsTr("No threads yet")
                color: Qt.alpha(sidebar.muted, 0.6)
                font.pixelSize: 12
                font.family: Theme.fontUi.length > 0 ? Theme.fontUi : Qt.application.font.family
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.margins: 8
            spacing: 4
            visible: sidebar.showFooter

            FooterButton {
                iconName: "settings"
                Accessible.name: qsTr("Settings")
                onClicked: Shell.dispatch("settings.open")
            }

            FooterButton {
                iconName: "git-pull-request"
                Accessible.name: qsTr("Pull requests")
                onClicked: Shell.dispatch("pullRequests.open")
            }

            FooterButton {
                iconName: "chart-no-axes-column"
                Accessible.name: qsTr("Usage")
                onClicked: Shell.dispatch("usage.open")
            }

            Item {
                Layout.fillWidth: true
            }
        }
    }

    component FooterButton: ShellButton {
        subtle: true
        implicitHeight: 32
        iconSize: 16
        iconTint: sidebar.iconColor
    }
}
