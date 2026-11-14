pragma Singleton
import QtQml

QtObject {
    property list<QtObject> screens: [QtObject { property rect geometry: Qt.rect(-100, 0, 400, 300) }]
    property list<Window> windows: [Window {
        pid: 123
        caption: "Draft"
        clientGeometry: Qt.rect(-100, 0, 400, 300)
    }]
    signal virtualScreenGeometryChanged()
    signal currentDesktopChanged()
    signal currentActivityChanged()
    property var pending: null
    property var events: []
    property int unloads: 0
    signal received(string event)
    function deliver(command) {
        const call = pending;
        pending = null;
        call.finished([JSON.stringify(command)]);
    }
}
