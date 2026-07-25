"""T3 Code's Hermes plugin lifecycle entry point."""

from __future__ import annotations

from typing import Any


def register(_ctx: Any) -> None:
    """Register the plugin.

    Service lifecycle is deliberately operator-driven through the dashboard
    extension. Importing the plugin must not download binaries or mutate the
    supervision tree.
    """

