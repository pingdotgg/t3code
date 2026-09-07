import QtQuick
import QtTest
import "../qml/T3/Bricks"
import T3.Shell

Item {
    id: root
    width: 400
    height: 600
    Component { id: component; SettingsNav { width: 300; height: 550 } }
    TestCase {
        name: "SettingsNavTests"
        when: windowShown
        function publish(query) {
            Shell.state = { settings: {
                active: true, activeSection: "/settings/general", searchQuery: query,
                sections: [{ to: "/settings/general", label: "General" }, { to: "/settings/providers", label: "Providers" }],
                searchResults: [{ to: "/settings/general", title: "Theme", sectionLabel: "General", targetId: "theme" }]
            } };
        }
        function init() { Shell.reset(); publish(""); }
        function cleanup() { Shell.reset(); }
        function test_keyboardNavigation() {
            let nav = createTemporaryObject(component, root);
            verify(!!nav, "Component exists");
            let row = findChild(nav, "settingsRow0");
            verify(!!row, "Object exists");
            row.focus = true;
            row.forceActiveFocus();
            keyClick(Qt.Key_Down);
            keyClick(Qt.Key_Return);
            compare(Shell.dispatchedActions[0].action, "settings.navigate");
            compare(Shell.dispatchedActions[0].payload.to, "/settings/providers");
            keyClick(Qt.Key_Up);
            keyClick(Qt.Key_Space);
            compare(Shell.dispatchedActions[1].payload.to, "/settings/general");
        }
        function test_escapeKeepsExternalSearchBinding() {
            publish("theme");
            let nav = createTemporaryObject(component, root);
            verify(!!nav, "Component exists");
            let search = findChild(nav, "search");
            verify(!!search, "Object exists");
            search.focus = true;
            search.forceActiveFocus();
            keyClick(Qt.Key_Escape);
            compare(Shell.dispatchedActions[0].payload.query, "");
            publish("");
            compare(search.text, "");
            publish("model 123 & provider");
            compare(search.text, "model 123 & provider");
        }
        function test_keyboardSearchResult() {
            publish("theme");
            let nav = createTemporaryObject(component, root);
            verify(!!nav, "Component exists");
            let row = findChild(nav, "settingsRow0");
            verify(!!row, "Object exists");
            row.focus = true;
            row.forceActiveFocus();
            keyClick(Qt.Key_Space);
            compare(Shell.dispatchedActions[0].action, "settings.openResult");
            compare(Shell.dispatchedActions[0].payload.targetId, "theme");
        }
    }
}
