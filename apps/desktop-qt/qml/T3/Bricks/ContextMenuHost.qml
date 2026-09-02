import QtQuick
import QtQuick.Controls.Basic
import T3.Shell

// Shows the page's pending context menu (Shell.state.contextMenu) when it
// targets this host's surface, and reports the choice back. One instance
// lives in each WebSurface (page coordinates) and one in the shell root
// (window coordinates, surfaceId "shell").
Item {
    id: host

    required property string surfaceId

    readonly property var request: Shell.state.contextMenu ?? null
    readonly property bool mine: request !== null && request.surfaceId === surfaceId
    property string shownRequestId: ""

    anchors.fill: parent

    function entries() {
        // Submenus flatten into a labelled section: one level is all the app uses.
        const out = [];
        for (const item of host.request.items) {
            if (item.children && item.children.length > 0) {
                out.push({
                    id: item.id,
                    label: item.label,
                    header: true,
                    separatorBefore: item.separatorBefore === true
                });
                for (const child of item.children) {
                    out.push(Object.assign({}, child, {
                        separatorBefore: child.separatorBefore === true
                    }));
                }
                continue;
            }
            out.push(Object.assign({}, item, {
                separatorBefore: item.separatorBefore === true
            }));
        }
        return out;
    }

    function choose(id) {
        if (host.request === null) {
            return;
        }
        const requestId = host.request.requestId;
        Shell.dispatch("contextMenu.select", {
            requestId: requestId,
            id: id
        });
    }

    onRequestChanged: {
        if (!mine) {
            if (menu.visible) {
                menu.close();
            }
            return;
        }
        if (request.requestId === shownRequestId) {
            return;
        }
        shownRequestId = request.requestId;
        menu.chosen = false;
        menu.popup(Math.min(request.x, host.width - menu.implicitWidth - 8), Math.min(request.y, host.height - menu.implicitHeight - 8));
    }

    ShellMenu {
        id: menu

        property bool chosen: false

        onClosed: {
            if (!chosen && host.mine) {
                host.choose(null);
            }
        }

        Instantiator {
            model: host.mine ? host.entries() : []

            delegate: ShellMenuItem {
                required property var modelData

                text: modelData.label
                enabled: modelData.disabled !== true && modelData.header !== true
                destructive: modelData.destructive === true
                font.bold: modelData.header === true
                onTriggered: {
                    menu.chosen = true;
                    host.choose(modelData.id);
                }
            }

            onObjectAdded: (index, object) => menu.insertItem(index, object)
            onObjectRemoved: (index, object) => menu.removeItem(object)
        }
    }
}
