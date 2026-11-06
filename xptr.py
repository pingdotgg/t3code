# Real X pointer control via XTest (ctypes). Usage: xptr.py move X Y | windows | resize WID W H | moveto WID X Y
import ctypes, ctypes.util, sys
X = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11"))
T = ctypes.cdll.LoadLibrary(ctypes.util.find_library("Xtst"))
X.XOpenDisplay.restype = ctypes.c_void_p
d = X.XOpenDisplay(None)
assert d, "no display"
X.XDefaultRootWindow.restype = ctypes.c_ulong
X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
X.XFlush.argtypes = [ctypes.c_void_p]
root = X.XDefaultRootWindow(d)
cmd = sys.argv[1]
if cmd == "move":
    T.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    T.XTestFakeMotionEvent(d, -1, int(sys.argv[2]), int(sys.argv[3]), 0)
elif cmd == "windows":
    class XWA(ctypes.Structure):
        _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int),
                    ("border_width", ctypes.c_int), ("depth", ctypes.c_int), ("visual", ctypes.c_void_p),
                    ("root", ctypes.c_ulong), ("c_class", ctypes.c_int), ("bit_gravity", ctypes.c_int),
                    ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int), ("backing_planes", ctypes.c_ulong),
                    ("backing_pixel", ctypes.c_ulong), ("save_under", ctypes.c_int), ("colormap", ctypes.c_ulong),
                    ("map_installed", ctypes.c_int), ("map_state", ctypes.c_int), ("all_event_masks", ctypes.c_long),
                    ("your_event_mask", ctypes.c_long), ("do_not_propagate_mask", ctypes.c_long),
                    ("override_redirect", ctypes.c_int), ("screen", ctypes.c_void_p)]
    r = ctypes.c_ulong(); p = ctypes.c_ulong(); ch = ctypes.POINTER(ctypes.c_ulong)(); n = ctypes.c_uint()
    X.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
    X.XQueryTree(d, root, ctypes.byref(r), ctypes.byref(p), ctypes.byref(ch), ctypes.byref(n))
    X.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XWA)]
    for i in range(n.value):
        a = XWA(); X.XGetWindowAttributes(d, ch[i], ctypes.byref(a))
        if a.map_state == 2: print(hex(ch[i]), a.x, a.y, a.width, a.height)
elif cmd == "moveresize":
    X.XMoveResizeWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint]
    X.XMoveResizeWindow(d, int(sys.argv[2], 16), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]))
elif cmd == "click":
    T.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    T.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    T.XTestFakeMotionEvent(d, -1, int(sys.argv[2]), int(sys.argv[3]), 0); X.XFlush(d)
    import time; time.sleep(0.2)
    T.XTestFakeButtonEvent(d, 1, 1, 0); X.XFlush(d); time.sleep(0.08)
    T.XTestFakeButtonEvent(d, 1, 0, 0); X.XFlush(d)
X.XFlush(d)
X.XCloseDisplay.argtypes = [ctypes.c_void_p]; X.XCloseDisplay(d)
