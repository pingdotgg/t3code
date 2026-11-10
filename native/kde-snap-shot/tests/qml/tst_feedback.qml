import QtQuick
import QtTest
import org.kde.kwin

TestCase {
    name: "KdeCaptureFeedback"
    when: windowShown
    property var feedback: null
    SignalSpy { id: receipt; target: Workspace; signalName: "received" }
    function create(animate) {
        const component = Qt.createComponent("../../src/feedback.qml");
        compare(component.status, Component.Ready, component.errorString());
        feedback = component.createObject(null, {
            options: { bounds: { x: -100, y: 0, width: 200, height: 100 }, pid: 123, flash: true, animate: animate },
            screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==",
            bus: "test",
            motionFactor: 0.01
        });
        verify(feedback !== null);
        if (!Workspace.events.some(event => event.event === "ready")) receipt.wait();
        verify(Workspace.events.some(event => event.event === "ready"));
    }
    function cleanup() {
        if (feedback) { feedback.finish(); feedback.destroy(); }
        feedback = null;
        Workspace.events = [];
        Workspace.pending = null;
        Workspace.unloads = 0;
        receipt.clear();
    }
    function test_flight_then_acknowledgement() {
        create(true);
        receipt.clear();
        Workspace.deliver({command: "animate", title: "Draft", frame: {x: 0.5, y: 0.5, width: 0.25, height: 0.2}});
        receipt.wait();
        compare(Workspace.events[Workspace.events.length - 1].event, "landed");
        compare(feedback.frame, Qt.rect(100, 150, 100, 60));
        verify(feedback.showing);
        Workspace.deliver({command: "close"});
        verify(!feedback.showing);
        compare(Workspace.events[Workspace.events.length - 1].event, "done");
    }
    function test_flash_without_flight() {
        create(false);
        compare(Workspace.events[0], {event: "ready", animate: false});
        Workspace.deliver({command: "close"});
        verify(!feedback.showing);
    }
    function test_owner_loss() {
        create(true);
        Workspace.pending.failed();
        verify(!feedback.showing);
        verify(feedback.closing);
        compare(Workspace.unloads, 1);
    }
    function test_output_change() {
        create(true);
        Workspace.virtualScreenGeometryChanged();
        verify(!feedback.showing);
    }
    function test_destination_moves_during_flight() {
        create(true);
        Workspace.deliver({command: "animate", title: "Draft", frame: {x: 0.5, y: 0.5, width: 0.25, height: 0.2}});
        Workspace.windows[0].clientGeometry = Qt.rect(-100, 1, 400, 300);
        verify(feedback.closing);
        verify(!feedback.showing);
        Workspace.windows[0].clientGeometry = Qt.rect(-100, 0, 400, 300);
    }
    function test_lock_cancels_during_flight() {
        create(true);
        Workspace.deliver({command: "animate", title: "Draft", frame: {x: 0.5, y: 0.5, width: 0.25, height: 0.2}});
        Workspace.deliver({command: "close"});
        verify(!feedback.showing);
        verify(feedback.closing);
    }
    function test_invalid_destination() {
        create(true);
        Workspace.deliver({command: "animate", title: "Wrong window", frame: {x: 0, y: 0, width: 1, height: 1}});
        verify(feedback.closing);
        verify(!feedback.showing);
    }
}
