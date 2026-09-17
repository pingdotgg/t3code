import QtQuick
import QtQuick.Window
import QtQml.Models
import org.kde.kwin
import "feedbackGeometry.js" as Geometry

// Internal output-only windows do not change, activate, or intercept input to the real window.
Item {
    id: root
    property var options: /*OPTIONS*/ null
    property string bus: /*BUS*/ ""
    property string scriptName: /*NAME*/ ""
    property real motionFactor: /*FACTOR*/ 1
    property rect frame: Qt.rect(options.bounds.x, options.bounds.y, options.bounds.width, options.bounds.height)
    property bool showing: false
    property bool started: false
    property bool closing: false
    property bool flying: false
    property bool initialized: false
    property bool readySent: false
    property real flashOpacity: 0
    property var target: null
    property url screenshot: Qt.resolvedUrl("capture.png")

    function finish() {
        if (closing) return;
        closing = true;
        showing = false;
        flight.stop();
        deadline.stop();
        done.call();
    }
    function begin() {
        if (started || closing) return;
        started = true;
        showing = true;
        if (options.flash) flash.start();
        next.call();
    }

    // A cached, bounded PNG is shared by each output. Nothing repaints while waiting for T3.
    Image {
        id: snapshot
        visible: false
        source: root.screenshot
        sourceSize.width: 2560
        sourceSize.height: 1600
        onStatusChanged: {
            if (status === Image.Ready && root.initialized) root.begin();
            else if (status === Image.Error) root.finish();
        }
    }
    Component.onCompleted: {
        initialized = true;
        if (snapshot.status === Image.Ready) begin();
        else if (snapshot.status === Image.Error) finish();
    }
    Instantiator {
        model: Workspace.screens
        delegate: Window {
            required property var modelData
            x: modelData.geometry.x
            y: modelData.geometry.y
            width: modelData.geometry.width
            height: modelData.geometry.height
            color: "transparent"
            visible: root.showing
            flags: Qt.ToolTip | Qt.FramelessWindowHint | Qt.BypassWindowManagerHint | Qt.WindowStaysOnTopHint | Qt.WindowTransparentForInput | Qt.WindowDoesNotAcceptFocus
            property bool outputOnly: true
            property bool kwin_shadow_enabled: false
            Connections {
                target: modelData
                function onGeometryChanged() { root.finish(); }
            }
            onFrameSwapped: {
                if (root.showing && !root.readySent) {
                    root.readySent = true;
                    ready.call();
                }
            }
            Item {
                x: root.frame.x - modelData.geometry.x
                y: root.frame.y - modelData.geometry.y
                width: root.frame.width
                height: root.frame.height
                Image {
                    anchors.fill: parent
                    visible: root.options.animate
                    source: snapshot.source
                    sourceSize: snapshot.sourceSize
                    fillMode: Image.Stretch
                }
            }
            Rectangle {
                x: root.options.bounds.x - modelData.geometry.x
                y: root.options.bounds.y - modelData.geometry.y
                width: root.options.bounds.width
                height: root.options.bounds.height
                color: "white"
                opacity: root.flashOpacity
            }
        }
    }
    NumberAnimation {
        id: flash
        target: root
        property: "flashOpacity"
        from: 0.10
        to: 0
        duration: 180
        easing.type: Easing.OutQuad
    }
    PropertyAnimation {
        id: flight
        target: root
        property: "frame"
        easing.type: Easing.OutCubic
        onFinished: landed.call()
    }
    Timer { id: deadline; interval: 6000; running: true; onTriggered: root.finish() }
    Connections {
        target: Workspace
        function onScreensChanged() { root.finish(); }
        function onVirtualScreenGeometryChanged() { root.finish(); }
        function onCurrentDesktopChanged() { root.finish(); }
        function onCurrentActivityChanged() { root.finish(); }
    }
    Connections {
        target: root.target
        function onClientGeometryChanged() { root.finish(); }
        function onClosed() { root.finish(); }
        function onMinimizedChanged() { root.finish(); }
    }
    DBusCall {
        id: next
        service: root.bus
        path: "/com/t3tools/KdeCapture/Feedback"
        dbusInterface: "com.t3tools.KdeCapture.Feedback"
        method: "Next"
        onFailed: root.finish()
        onFinished: (values) => {
            if (root.closing) return;
            try {
                const command = JSON.parse(values[0]);
                if (command.command === "close") { root.finish(); return; }
                if (command.command !== "animate" || root.flying || !root.options.animate)
                    throw new Error("Invalid capture feedback command");
                const destination = Geometry.destination(Workspace.windows, root.options.pid, command.title, command.frame);
                root.target = destination.window;
                const frame = destination.frame;
                const distance = Math.hypot(frame.x - root.frame.x, frame.y - root.frame.y);
                flight.duration = Math.round((680 - 400 * Math.exp(-distance / 2000)) * root.motionFactor);
                flight.to = Qt.rect(frame.x, frame.y, frame.width, frame.height);
                root.flying = true;
                flight.start();
                // Keep a pending call during the animation for cancellation and owner loss.
                next.call();
            } catch (error) { root.finish(); }
        }
    }
    DBusCall {
        id: ready
        service: root.bus
        path: "/com/t3tools/KdeCapture/Feedback"
        dbusInterface: "com.t3tools.KdeCapture.Feedback"
        method: "Event"
        arguments: [JSON.stringify({event: "ready", animate: root.options.animate})]
        onFailed: root.finish()
    }
    DBusCall {
        id: landed
        service: root.bus
        path: "/com/t3tools/KdeCapture/Feedback"
        dbusInterface: "com.t3tools.KdeCapture.Feedback"
        method: "Event"
        arguments: ['{"event":"landed"}']
        onFailed: root.finish()
    }
    DBusCall {
        id: done
        service: root.bus
        path: "/com/t3tools/KdeCapture/Feedback"
        dbusInterface: "com.t3tools.KdeCapture.Feedback"
        method: "Event"
        arguments: ['{"event":"done"}']
        onFinished: unload.call()
        onFailed: unload.call()
    }
    // Also unload after helper loss; a hidden script would otherwise retain the screenshot.
    DBusCall {
        id: unload
        service: "org.kde.KWin"
        path: "/Scripting"
        dbusInterface: "org.kde.kwin.Scripting"
        method: "unloadScript"
        arguments: [root.scriptName]
    }
}
