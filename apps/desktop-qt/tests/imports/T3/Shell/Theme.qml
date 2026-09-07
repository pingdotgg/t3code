pragma Singleton
import QtQuick

QtObject {
    property real radius: 8
    readonly property string fontUi: ""
    property var colors: ({})

    function color(role, fallback) {
        return colors[role] ?? fallback;
    }
}
