"""Isolated entry point for coherent Hermes product updates."""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print("invalid coherent update invocation", file=sys.stderr)
        return 2
    plugin_root = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(plugin_root))
    from integrations.hermes_plugin.coherent_update import main as update_main

    return update_main(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
