pragma Singleton
import QtQuick
import QtWebEngine

// One persistent profile for every web surface, so a second view (an embed
// route) shares the primary view's pairing session.
QtObject {
    id: root

    readonly property WebEngineProfilePrototype prototype: WebEngineProfilePrototype {
        storageName: "t3code"
        persistentCookiesPolicy: WebEngineProfile.ForcePersistentCookies
    }
    readonly property var instance: prototype.instance()
}
