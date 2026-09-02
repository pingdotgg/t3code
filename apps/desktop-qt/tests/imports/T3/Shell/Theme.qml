pragma Singleton
import QtQuick

QtObject {
    readonly property real radius: 8
    readonly property string fontUi: ""

    function color(role, fallback) {
        return fallback;
    }
}
