"""T3 Code gateway plugin registration for Hermes Agent."""
# ruff: noqa: N999 - Hermes loads hyphenated plugin directories dynamically.

from __future__ import annotations

from .adapter import (
    T3PlatformAdapter,
    check_requirements,
    env_enablement,
    validate_config,
)
from .cli import register_cli, t3_command


def _pre_tool_call(
    tool_name: str,
    args: dict,
    task_id: str,
    **kwargs,
) -> None:
    session_id = str(kwargs.get("session_id") or task_id)
    tool_call_id = str(kwargs.get("tool_call_id") or "")
    T3PlatformAdapter.route_tool_started(tool_name, args, session_id, tool_call_id)


def _post_tool_call(
    tool_name: str,
    args: dict,
    result: str,
    task_id: str,
    duration_ms: int | None = None,
    **kwargs,
) -> None:
    del args
    session_id = str(kwargs.get("session_id") or task_id)
    tool_call_id = str(kwargs.get("tool_call_id") or "")
    status = str(kwargs.get("status") or "")
    T3PlatformAdapter.route_tool_completed(
        tool_name, result, session_id, duration_ms, tool_call_id, status
    )


def register(ctx) -> None:
    ctx.register_platform(
        name="t3",
        label="T3 Code",
        adapter_factory=lambda config: T3PlatformAdapter(config),
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=[
            "HERMES_T3_GATEWAY_URL",
            "HERMES_T3_GATEWAY_INSTANCE_ID",
            "HERMES_T3_GATEWAY_CREDENTIAL",
        ],
        env_enablement_fn=env_enablement,
        max_message_length=120_000,
        emoji="🔺",
        pii_safe=True,
        platform_hint=(
            "You are chatting through T3 Code. Preserve normal Hermes behavior; "
            "T3 renders streamed text, tool activity, approvals, and questions."
        ),
    )
    ctx.register_cli_command(
        name="t3",
        help="Pair and inspect the T3 Code gateway",
        setup_fn=register_cli,
        handler_fn=t3_command,
        description=(
            "Connect this Hermes process to a named T3 Code provider instance."
        ),
    )
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)


__all__ = ["register"]
