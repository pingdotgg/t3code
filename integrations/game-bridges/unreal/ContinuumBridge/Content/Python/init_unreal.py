# Unreal runs init_unreal.py from every enabled plugin's Content/Python folder at editor startup.
import unreal

try:
    import continuum_bridge

    continuum_bridge.start(unreal)
except Exception as error:  # Never block the editor from starting.
    unreal.log_warning("[Continuum] Bridge did not start: {}".format(error))
