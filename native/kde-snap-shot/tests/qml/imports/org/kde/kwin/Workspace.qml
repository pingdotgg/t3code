pragma Singleton
import QtQml

// No KWin process, desktop bus, or real screen is used by these tests.
QtObject {
    property list<QtObject> screens: [QtObject { property rect geometry: Qt.rect(-100, 0, 400, 300) }]
    property list<QtObject> windows: [QtObject {
        property int pid: 123
        property string caption: "Draft"
        property bool minimized: false
        property rect clientGeometry: Qt.rect(-100, 0, 400, 300)
        signal closed()
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
