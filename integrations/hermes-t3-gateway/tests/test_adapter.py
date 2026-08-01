from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import enum
import importlib.util
import pathlib
import shlex
import sys
import tempfile
import types
import unittest
import unittest.mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = "hermes_t3_gateway_adapter_test"


class Platform(str, enum.Enum):
    T3 = "t3"

    @classmethod
    def _missing_(cls, value):
        if value == "t3":
            return cls.T3
        return None


@dataclasses.dataclass
class PlatformConfig:
    enabled: bool = True
    extra: dict = dataclasses.field(default_factory=dict)


class MessageType(enum.Enum):
    TEXT = "text"
    COMMAND = "command"


@dataclasses.dataclass
class MessageEvent:
    text: str
    message_type: MessageType
    source: object
    message_id: str
    metadata: dict
    # Media attachments, defaulted exactly like upstream
    # (`gateway/platforms/base.py:1801`): local file paths plus aligned MIMEs.
    media_urls: list = dataclasses.field(default_factory=list)
    media_types: list = dataclasses.field(default_factory=list)


@dataclasses.dataclass
class SendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None


@dataclasses.dataclass
class Source:
    platform: Platform
    chat_id: str
    message_id: str


class FakeGatewayRunner:
    def __init__(self):
        self._session_model_overrides = {}
        self._session_reasoning_overrides = {}
        self.default_model = "default-model"
        self.default_provider = "openrouter"
        self.reasoning_models = []

    def _session_key_for_source(self, source):
        return build_session_key(source)

    def _resolve_session_agent_runtime(self, *, session_key):
        override = self._session_model_overrides.get(session_key, {})
        return override.get("model", self.default_model), {
            "provider": override.get("provider", self.default_provider)
        }

    def _resolve_session_reasoning_config(self, *, session_key, model=""):
        self.reasoning_models.append(model)
        return self._session_reasoning_overrides.get(session_key)


class BasePlatformAdapter:
    def __init__(self, config, platform):
        self.config = config
        self.platform = platform
        self._status_text = {}
        self.messages = []
        self._running = False
        self._message_handler = None

    def build_source(self, *, chat_id, message_id, **kwargs):
        return Source(self.platform, str(chat_id), str(message_id))

    async def handle_message(self, event):
        self.messages.append(event)
        if (
            self._message_handler is not None
            and event.message_type == MessageType.COMMAND
            and event.text.startswith("/steer ")
        ):
            # Faithful model of Hermes BasePlatformAdapter's active-command
            # bypass path (gateway/platforms/base.py ~4926 at upstream
            # 62e07223): the gateway handler returns a control
            # acknowledgement, then the base adapter sends it through the
            # platform adapter with `reply_to=_reply_anchor_for_event(event)`
            # — which, for a platform with no thread_id, is the dispatched
            # event's own message_id — and notify=True metadata.
            response = await self._message_handler(event)
            if response:
                await self.send(
                    event.source.chat_id,
                    response,
                    reply_to=event.message_id,
                    metadata={"notify": True},
                )

    async def interrupt_session_activity(self, session_key, chat_id):
        self.interrupted = (session_key, chat_id)

    def set_status_text(self, chat_id, text):
        if text:
            self._status_text[str(chat_id)] = text
        else:
            self._status_text.pop(str(chat_id), None)

    def _mark_connected(self):
        self._running = True

    def _mark_disconnected(self):
        self._running = False

    def _set_fatal_error(self, *args, **kwargs):
        self.fatal_error = (args, kwargs)


def build_session_key(source):
    return f"agent:main:t3:dm:{source.chat_id}"


def install_fake_hermes_modules():
    gateway = types.ModuleType("gateway")
    config = types.ModuleType("gateway.config")
    config.Platform = Platform
    config.PlatformConfig = PlatformConfig
    platforms = types.ModuleType("gateway.platforms")
    base = types.ModuleType("gateway.platforms.base")
    base.BasePlatformAdapter = BasePlatformAdapter
    base.MessageEvent = MessageEvent
    base.MessageType = MessageType
    base.SendResult = SendResult
    session = types.ModuleType("gateway.session")
    session.build_session_key = build_session_key
    sys.modules.update(
        {
            "gateway": gateway,
            "gateway.config": config,
            "gateway.platforms": platforms,
            "gateway.platforms.base": base,
            "gateway.session": session,
        }
    )


def load_plugin_modules():
    install_fake_hermes_modules()
    package = types.ModuleType(PACKAGE)
    package.__path__ = [str(ROOT)]
    sys.modules[PACKAGE] = package
    for name in ("protocol", "connection", "cli", "home", "adapter"):
        spec = importlib.util.spec_from_file_location(
            f"{PACKAGE}.{name}", ROOT / f"{name}.py"
        )
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules[f"{PACKAGE}.{name}"] = module
        spec.loader.exec_module(module)
    return sys.modules[f"{PACKAGE}.adapter"]


adapter_module = load_plugin_modules()
protocol_module = sys.modules[f"{PACKAGE}.protocol"]
home_module = sys.modules[f"{PACKAGE}.home"]


@contextlib.contextmanager
def hermes_without_describe_surfaces():
    """Model an older Hermes: the modules import, the accessors are absent."""
    names = ("hermes_cli", "hermes_cli.config", "tools", "tools.skills_tool")
    saved = {name: sys.modules.get(name) for name in names}
    hermes_cli = types.ModuleType("hermes_cli")
    hermes_cli.__path__ = []
    config = types.ModuleType("hermes_cli.config")
    tools = types.ModuleType("tools")
    tools.__path__ = []
    skills_tool = types.ModuleType("tools.skills_tool")
    sys.modules.update(
        {
            "hermes_cli": hermes_cli,
            "hermes_cli.config": config,
            "tools": tools,
            "tools.skills_tool": skills_tool,
        }
    )
    try:
        yield
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


class FakeConnection:
    def __init__(self):
        self.connected = True
        self.messages = []

    async def send(self, message):
        self.messages.append(message)


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.adapter = adapter_module.T3PlatformAdapter(
            PlatformConfig(
                extra={
                    "url": "wss://t3.example/api/hermes-gateway/ws",
                    "instance_id": "instance",
                    "credential": "credential",
                }
            )
        )
        self.connection = FakeConnection()
        self.adapter._connection = self.connection

    async def _start_turn(self, thread_id: str, turn_id: str):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": f"ensure-{thread_id}",
                "threadId": thread_id,
            }
        )
        session_id = self.adapter._sessions[thread_id]
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": f"start-{thread_id}",
                "threadId": thread_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "text": "Start",
            }
        )
        return session_id

    async def _ensure_thread(self, thread_id: str) -> str:
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": f"ensure-{thread_id}",
                "threadId": thread_id,
            }
        )
        return self.adapter._sessions[thread_id]

    def _install_configuration_handler(self, *, apply_model=True):
        runner = FakeGatewayRunner()
        commands = []
        observations = []

        async def handler(event):
            commands.append(event.text)
            observations.append(
                {
                    "active": event.source.chat_id in self.adapter._active_turns,
                    "frames": [message["type"] for message in self.connection.messages],
                }
            )
            tokens = shlex.split(event.text)
            session_id = runner._session_key_for_source(event.source)
            if tokens[0] == "/model" and apply_model:
                runner._session_model_overrides[session_id] = {
                    "model": tokens[1],
                    "provider": tokens[tokens.index("--provider") + 1],
                }
            elif tokens[0] == "/reasoning":
                effort = tokens[1]
                runner._session_reasoning_overrides[session_id] = (
                    {"enabled": False}
                    if effort == "none"
                    else {"enabled": True, "effort": effort}
                )
            elif tokens[0] == "/steer":
                return "⏩ Steer queued for the active session"
            return "control acknowledgement that must stay hidden"

        self.adapter.gateway_runner = runner
        self.adapter._message_handler = handler
        return runner, commands, observations

    async def test_thread_ensure_start_stream_and_complete(self):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "ensure-1",
                "threadId": "thread-1",
            }
        )
        ready = self.connection.messages[-2]
        self.assertEqual(ready["type"], "session.ready")
        self.assertEqual(ready["sessionId"], "agent:main:t3:dm:thread-1")
        self.assertEqual(self.connection.messages[-1]["activeSessionCount"], 1)

        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-1",
                "threadId": "thread-1",
                "sessionId": ready["sessionId"],
                "turnId": "turn-1",
                "text": "Hello Hermes",
            }
        )
        self.assertEqual(self.adapter.messages[-1].text, "Hello Hermes")
        await self.adapter.send("thread-1", "Hello", metadata={"expect_edits": True})
        # `finalize` must NOT complete the turn — the gateway's progress loop
        # sets it on every progress edit. Only a `notify=True` send does.
        await self.adapter.edit_message(
            "thread-1", "message", "Hello world", finalize=True
        )
        self.assertNotIn(
            "turn.completed", [m["type"] for m in self.connection.messages]
        )
        await self.adapter.send("thread-1", "Hello world", metadata={"notify": True})
        types_seen = [message["type"] for message in self.connection.messages]
        self.assertIn("content.delta", types_seen)
        self.assertIn("turn.completed", types_seen)
        deltas = [
            message["delta"]
            for message in self.connection.messages
            if message["type"] == "content.delta"
        ]
        self.assertEqual(deltas, ["Hello", " world"])

    async def test_turn_configuration_is_applied_before_start_and_ack_is_hidden(self):
        session_id = await self._ensure_thread("thread-configured")
        runner, commands, observations = self._install_configuration_handler()
        cached_agent = types.SimpleNamespace(model="prior-model")
        cached_entry = (cached_agent, "prior-signature")
        runner._agent_cache = {session_id: cached_entry}
        runner._agent_cache_lock = None
        evicted = []

        def evict_cached_agent(key):
            evicted.append(runner._agent_cache.pop(key, None))

        runner._evict_cached_agent = evict_cached_agent
        frames_before = len(self.connection.messages)

        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-configured",
                "threadId": "thread-configured",
                "sessionId": session_id,
                "turnId": "turn-configured",
                "text": "Run the tests",
                "modelSelection": {
                    "mode": "specific",
                    "provider": "openai-codex",
                    "model": "gpt-5.4",
                },
                "reasoningEffort": "high",
            }
        )

        self.assertEqual(
            commands,
            [
                "/model gpt-5.4 --provider openai-codex --session",
                "/reasoning high",
            ],
        )
        self.assertTrue(all(not seen["active"] for seen in observations))
        self.assertTrue(
            all("turn.started" not in seen["frames"] for seen in observations)
        )
        started = self.connection.messages[frames_before]
        self.assertEqual(started["type"], "turn.started")
        self.assertEqual(
            started["appliedModelSelection"],
            {"provider": "openai-codex", "model": "gpt-5.4"},
        )
        self.assertEqual(started["appliedReasoningEffort"], "high")
        self.assertEqual(
            runner._session_model_overrides[session_id]["model"], "gpt-5.4"
        )
        self.assertEqual(evicted, [cached_entry])
        self.assertNotIn(session_id, runner._agent_cache)
        self.assertEqual(cached_agent.model, "prior-model")
        # Direct control dispatch never entered BasePlatformAdapter, so its
        # textual acknowledgements could not become T3 transcript messages.
        self.assertEqual(
            [event.text for event in self.adapter.messages], ["Run the tests"]
        )

    async def test_invalid_reasoning_is_rejected_before_model_mutation(self):
        session_id = await self._ensure_thread("thread-invalid-config")
        runner, commands, _ = self._install_configuration_handler()

        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-invalid-config",
                "threadId": "thread-invalid-config",
                "sessionId": session_id,
                "turnId": "turn-invalid-config",
                "text": "Do not run",
                "modelSelection": {
                    "mode": "specific",
                    "provider": "openai-codex",
                    "model": "gpt-5.4",
                },
                "reasoningEffort": "impossible",
            }
        )

        self.assertEqual(commands, [])
        self.assertEqual(runner._session_model_overrides, {})
        self.assertEqual(self.connection.messages[-1]["type"], "protocol.error")
        self.assertEqual(
            self.connection.messages[-1]["requestId"], "start-invalid-config"
        )
        self.assertNotIn("thread-invalid-config", self.adapter._active_turns)

    async def test_default_model_mode_uses_an_explicit_session_switch(self):
        session_id = await self._ensure_thread("thread-default-model")
        runner, commands, _ = self._install_configuration_handler()
        with unittest.mock.patch.object(
            adapter_module,
            "configured_model_selection",
            return_value={
                "provider": "custom provider",
                "model": "model with spaces",
            },
        ):
            await self.adapter._handle_server_frame(
                {
                    "type": "turn.start",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": "start-default-model",
                    "threadId": "thread-default-model",
                    "sessionId": session_id,
                    "turnId": "turn-default-model",
                    "text": "Run",
                    "modelSelection": {"mode": "default"},
                }
            )

        self.assertEqual(
            commands,
            [
                "/model 'model with spaces' --provider 'custom provider' --session"
            ],
        )
        started = next(
            frame
            for frame in reversed(self.connection.messages)
            if frame["type"] == "turn.started"
        )
        self.assertEqual(
            started["appliedModelSelection"],
            {"provider": "custom provider", "model": "model with spaces"},
        )
        self.assertEqual(runner._session_reasoning_overrides, {})

    async def test_reasoning_only_turn_uses_the_current_effective_model(self):
        session_id = await self._ensure_thread("thread-reasoning-only")
        runner, commands, _ = self._install_configuration_handler()

        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-reasoning-only",
                "threadId": "thread-reasoning-only",
                "sessionId": session_id,
                "turnId": "turn-reasoning-only",
                "text": "Run",
                "reasoningEffort": "ultra",
            }
        )

        self.assertEqual(commands, ["/reasoning ultra"])
        started = next(
            frame
            for frame in reversed(self.connection.messages)
            if frame["type"] == "turn.started"
        )
        self.assertNotIn("appliedModelSelection", started)
        self.assertEqual(started["appliedReasoningEffort"], "ultra")
        self.assertEqual(
            runner._session_reasoning_overrides[session_id],
            {"enabled": True, "effort": "ultra"},
        )
        self.assertEqual(runner.reasoning_models, [runner.default_model])

    async def test_failed_model_switch_does_not_apply_reasoning_or_start(self):
        session_id = await self._ensure_thread("thread-model-failure")
        runner, commands, _ = self._install_configuration_handler(
            apply_model=False
        )

        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-model-failure",
                "threadId": "thread-model-failure",
                "sessionId": session_id,
                "turnId": "turn-model-failure",
                "text": "Do not run",
                "modelSelection": {
                    "mode": "specific",
                    "provider": "openai-codex",
                    "model": "gpt-5.4",
                },
                "reasoningEffort": "high",
            }
        )

        self.assertEqual(
            commands, ["/model gpt-5.4 --provider openai-codex --session"]
        )
        self.assertEqual(runner._session_reasoning_overrides, {})
        self.assertEqual(self.connection.messages[-1]["type"], "protocol.error")
        self.assertNotIn("thread-model-failure", self.adapter._active_turns)
        self.assertNotIn(
            "thread-model-failure", self.adapter._applied_turn_configuration
        )

    async def test_concurrent_starts_reserve_the_preconfiguration_window(self):
        thread_id = "thread-concurrent-start"
        session_id = await self._ensure_thread(thread_id)
        runner, commands, _ = self._install_configuration_handler()
        original_handler = self.adapter._message_handler
        configuration_entered = asyncio.Event()
        release_configuration = asyncio.Event()

        async def blocking_handler(event):
            configuration_entered.set()
            await release_configuration.wait()
            return await original_handler(event)

        self.adapter._message_handler = blocking_handler

        def start_message(request_id, turn_id, model):
            return {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": request_id,
                "threadId": thread_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "text": f"Run {turn_id}",
                "modelSelection": {
                    "mode": "specific",
                    "provider": "openai-codex",
                    "model": model,
                },
            }

        first = asyncio.create_task(
            self.adapter._handle_server_frame(
                start_message("start-concurrent-1", "turn-concurrent-1", "gpt-5.4")
            )
        )
        await asyncio.wait_for(configuration_entered.wait(), timeout=1)

        await self.adapter._handle_server_frame(
            start_message("start-concurrent-2", "turn-concurrent-2", "gpt-5.5")
        )

        second_error = next(
            message
            for message in self.connection.messages
            if message.get("requestId") == "start-concurrent-2"
        )
        self.assertEqual(second_error["type"], "protocol.error")
        self.assertEqual(second_error["code"], "invalid-message")
        self.assertEqual(commands, [])

        release_configuration.set()
        await first

        self.assertEqual(
            commands, ["/model gpt-5.4 --provider openai-codex --session"]
        )
        self.assertEqual(
            runner._session_model_overrides[session_id]["model"], "gpt-5.4"
        )
        self.assertEqual(
            [event.text for event in self.adapter.messages], ["Run turn-concurrent-1"]
        )
        self.assertEqual(
            self.adapter._active_turns[thread_id].turn_id, "turn-concurrent-1"
        )
        self.assertNotIn(thread_id, self.adapter._turn_start_reservations)

    async def test_stop_racing_configuration_fences_and_rolls_back_the_start(self):
        thread_id = "thread-stop-start"
        session_id = await self._ensure_thread(thread_id)
        runner = FakeGatewayRunner()
        configuration_mutated = asyncio.Event()
        release_configuration = asyncio.Event()

        async def handler(event):
            tokens = shlex.split(event.text)
            command_session_id = runner._session_key_for_source(event.source)
            runner._session_model_overrides[command_session_id] = {
                "model": tokens[1],
                "provider": tokens[tokens.index("--provider") + 1],
            }
            configuration_mutated.set()
            await release_configuration.wait()
            return "hidden"

        self.adapter.gateway_runner = runner
        self.adapter._message_handler = handler
        start = asyncio.create_task(
            self.adapter._handle_server_frame(
                {
                    "type": "turn.start",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": "start-stop-race",
                    "threadId": thread_id,
                    "sessionId": session_id,
                    "turnId": "turn-stop-race",
                    "text": "Must not run",
                    "modelSelection": {
                        "mode": "specific",
                        "provider": "openai-codex",
                        "model": "gpt-5.4",
                    },
                }
            )
        )
        await asyncio.wait_for(configuration_mutated.wait(), timeout=1)

        await self.adapter._handle_server_frame(
            {
                "type": "session.stop",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "stop-start-race",
                "threadId": thread_id,
                "sessionId": session_id,
            }
        )
        self.assertTrue(
            self.adapter._turn_start_reservations[thread_id].cancelled
        )
        # A fast re-ensure must not revive the already-stopped start.
        self.assertEqual(await self._ensure_thread(thread_id), session_id)

        release_configuration.set()
        await start

        self.assertEqual(runner._session_model_overrides, {})
        self.assertNotIn(thread_id, self.adapter._applied_turn_configuration)
        self.assertNotIn(thread_id, self.adapter._active_turns)
        self.assertNotIn(thread_id, self.adapter._turn_start_reservations)
        self.assertEqual(self.adapter.messages, [])
        self.assertFalse(
            any(
                message["type"] == "turn.started"
                and message.get("requestId") == "start-stop-race"
                for message in self.connection.messages
            )
        )
        start_error = next(
            message
            for message in self.connection.messages
            if message.get("requestId") == "start-stop-race"
        )
        self.assertEqual(start_error["type"], "protocol.error")
        self.assertIn("stopped", start_error["message"])

    async def test_profile_aware_session_key_is_used_for_config_and_verification(self):
        thread_id = "thread-multiplex"
        profile_session_id = f"agent:work:t3:dm:{thread_id}"
        runner, commands, _ = self._install_configuration_handler()
        runner._session_key_for_source = lambda source: (
            f"agent:work:t3:dm:{source.chat_id}"
        )

        session_id = await self._ensure_thread(thread_id)
        self.assertEqual(session_id, profile_session_id)

        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-multiplex",
                "threadId": thread_id,
                "sessionId": session_id,
                "turnId": "turn-multiplex",
                "text": "Run",
                "modelSelection": {
                    "mode": "specific",
                    "provider": "openai-codex",
                    "model": "gpt-5.4",
                },
                "reasoningEffort": "xhigh",
            }
        )

        self.assertEqual(
            commands,
            [
                "/model gpt-5.4 --provider openai-codex --session",
                "/reasoning xhigh",
            ],
        )
        self.assertEqual(
            set(runner._session_model_overrides), {profile_session_id}
        )
        self.assertEqual(
            set(runner._session_reasoning_overrides), {profile_session_id}
        )
        started = next(
            message
            for message in self.connection.messages
            if message.get("requestId") == "start-multiplex"
        )
        self.assertEqual(started["type"], "turn.started")
        self.assertEqual(started["appliedReasoningEffort"], "xhigh")

    async def test_reasoning_failure_restores_model_reasoning_and_cache(self):
        thread_id = "thread-atomic-config"
        session_id = await self._ensure_thread(thread_id)
        runner = FakeGatewayRunner()
        prior_model = {"provider": "old-provider", "model": "old-model"}
        prior_reasoning = {"enabled": True, "effort": "low"}
        prior_cache = {
            "modelRequest": ("specific", "old-provider", "old-model"),
            "modelEffective": dict(prior_model),
            "reasoningRequest": "low",
            "reasoningEffective": "low",
        }
        runner._session_model_overrides[session_id] = dict(prior_model)
        runner._session_reasoning_overrides[session_id] = dict(prior_reasoning)
        runner._pending_model_notes = {session_id: "prior model note"}
        runner._pending_one_turn_model_restores = {
            session_id: {"had_override": True, "override": dict(prior_model)}
        }
        runner._reasoning_config = dict(prior_reasoning)
        runner._session_ephemeral_pin = {session_id: "prior prompt pin"}
        runner._session_vc_last = {session_id: "prior voice channel"}
        cached_agent = types.SimpleNamespace(model="old-model")
        cached_entry = (cached_agent, "prior-cache-signature")
        runner._agent_cache = {session_id: cached_entry}
        runner._agent_cache_lock = None

        session_entry = types.SimpleNamespace(
            session_id="durable-session-id",
            was_auto_reset=True,
        )

        class FakeAsyncSessionStore:
            def __init__(self):
                self.model_overrides = {session_id: dict(prior_model)}

            async def get_or_create_session(self, source):
                del source
                return session_entry

            async def get_model_override(self, key):
                value = self.model_overrides.get(key)
                return dict(value) if value is not None else None

            async def set_model_override(self, key, value):
                if value is None:
                    self.model_overrides.pop(key, None)
                else:
                    self.model_overrides[key] = dict(value)

        prior_db_row = {
            "model": "old-model",
            "model_config": '{"browser_model_lock":"old-model"}',
            "system_prompt": "prior system prompt",
        }

        class FakeSessionDB:
            def __init__(self):
                self.rows = {session_entry.session_id: dict(prior_db_row)}

            async def get_session(self, key):
                row = self.rows.get(key)
                return dict(row) if row is not None else None

            async def update_session_model(self, key, model):
                row = self.rows[key]
                row["model"] = model
                row["model_config"] = None
                row["system_prompt"] = None

            async def update_session_meta(self, key, model_config, model=None):
                row = self.rows[key]
                row["model_config"] = model_config
                if model is not None:
                    row["model"] = model

            async def update_system_prompt(self, key, system_prompt):
                self.rows[key]["system_prompt"] = system_prompt

        runner.async_session_store = FakeAsyncSessionStore()
        runner._session_db = FakeSessionDB()
        self.adapter._applied_turn_configuration[thread_id] = dict(prior_cache)
        commands = []

        async def handler(event):
            commands.append(event.text)
            tokens = shlex.split(event.text)
            command_session_id = runner._session_key_for_source(event.source)
            if tokens[0] == "/model":
                cached = runner._agent_cache.get(command_session_id)
                if cached is not None:
                    cached[0].model = tokens[1]
                durable_entry = await runner.async_session_store.get_or_create_session(
                    event.source
                )
                durable_entry.was_auto_reset = False
                await runner._session_db.update_session_model(
                    durable_entry.session_id, tokens[1]
                )
                runner._pending_model_notes[command_session_id] = "new model note"
                runner._session_model_overrides[command_session_id] = {
                    "model": tokens[1],
                    "provider": tokens[tokens.index("--provider") + 1],
                }
                await runner.async_session_store.set_model_override(
                    command_session_id,
                    runner._session_model_overrides[command_session_id],
                )
                runner._pending_one_turn_model_restores.pop(
                    command_session_id, None
                )
                runner._session_ephemeral_pin.pop(command_session_id, None)
                runner._session_vc_last.pop(command_session_id, None)
                runner._agent_cache.pop(command_session_id, None)
                return "hidden"
            runner._reasoning_config = {"enabled": True, "effort": tokens[1]}
            runner._session_reasoning_overrides[command_session_id] = {
                "enabled": True,
                "effort": tokens[1],
            }
            raise RuntimeError("reasoning command failed after mutation")

        self.adapter.gateway_runner = runner
        self.adapter._message_handler = handler
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-atomic-config",
                "threadId": thread_id,
                "sessionId": session_id,
                "turnId": "turn-atomic-config",
                "text": "Must not run",
                "modelSelection": {
                    "mode": "specific",
                    "provider": "openai-codex",
                    "model": "gpt-5.4",
                },
                "reasoningEffort": "high",
            }
        )

        self.assertEqual(
            commands,
            [
                "/model gpt-5.4 --provider openai-codex --session",
                "/reasoning high",
            ],
        )
        self.assertEqual(
            runner._session_model_overrides, {session_id: prior_model}
        )
        self.assertEqual(
            runner._session_reasoning_overrides, {session_id: prior_reasoning}
        )
        self.assertEqual(
            runner._pending_model_notes, {session_id: "prior model note"}
        )
        self.assertEqual(
            runner._pending_one_turn_model_restores,
            {session_id: {"had_override": True, "override": prior_model}},
        )
        self.assertEqual(runner._reasoning_config, prior_reasoning)
        self.assertEqual(
            runner.async_session_store.model_overrides,
            {session_id: prior_model},
        )
        self.assertTrue(session_entry.was_auto_reset)
        self.assertEqual(
            runner._session_db.rows,
            {session_entry.session_id: prior_db_row},
        )
        self.assertIs(runner._agent_cache[session_id], cached_entry)
        self.assertEqual(cached_agent.model, "old-model")
        self.assertEqual(
            runner._session_ephemeral_pin, {session_id: "prior prompt pin"}
        )
        self.assertEqual(
            runner._session_vc_last, {session_id: "prior voice channel"}
        )
        self.assertEqual(
            self.adapter._applied_turn_configuration, {thread_id: prior_cache}
        )
        self.assertNotIn(thread_id, self.adapter._active_turns)
        self.assertEqual(self.adapter.messages, [])
        error = self.connection.messages[-1]
        self.assertEqual(error["type"], "protocol.error")
        self.assertEqual(error["requestId"], "start-atomic-config")

    async def test_store_rollback_failure_still_restores_session_database(self):
        thread_id = "thread-partial-durable-rollback"
        session_id = await self._ensure_thread(thread_id)
        runner = FakeGatewayRunner()
        prior_model = {"provider": "old-provider", "model": "old-model"}
        runner._session_model_overrides[session_id] = dict(prior_model)
        session_entry = types.SimpleNamespace(
            session_id="partial-rollback-session",
            was_auto_reset=False,
        )

        class FailingRestoreStore:
            def __init__(self):
                self.persisted = dict(prior_model)
                self.fail_restore = False
                self.restore_attempts = 0

            async def get_or_create_session(self, source):
                del source
                return session_entry

            async def get_model_override(self, key):
                self.assert_session(key)
                return dict(self.persisted)

            async def set_model_override(self, key, value):
                self.assert_session(key)
                if self.fail_restore:
                    self.restore_attempts += 1
                    raise RuntimeError("routing store restore failed")
                self.persisted = dict(value)

            @staticmethod
            def assert_session(key):
                if key != session_id:
                    raise AssertionError(f"unexpected session key: {key}")

        prior_db_row = {
            "model": "old-model",
            "model_config": '{"browser_model_lock":"old-model"}',
            "system_prompt": "prior system prompt",
        }

        class RecordingSessionDB:
            def __init__(self):
                self.row = dict(prior_db_row)
                self.calls = []

            async def get_session(self, key):
                self.assert_session(key)
                return dict(self.row)

            async def update_session_model(self, key, model):
                self.assert_session(key)
                self.calls.append(("model", model))
                self.row["model"] = model
                self.row["model_config"] = None
                self.row["system_prompt"] = None

            async def update_session_meta(self, key, model_config, model=None):
                self.assert_session(key)
                self.calls.append(("meta", model_config, model))
                self.row["model_config"] = model_config
                if model is not None:
                    self.row["model"] = model

            async def update_system_prompt(self, key, system_prompt):
                self.assert_session(key)
                self.calls.append(("prompt", system_prompt))
                self.row["system_prompt"] = system_prompt

            @staticmethod
            def assert_session(key):
                if key != session_entry.session_id:
                    raise AssertionError(f"unexpected database session: {key}")

        store = FailingRestoreStore()
        session_db = RecordingSessionDB()
        runner.async_session_store = store
        runner._session_db = session_db

        async def handler(event):
            tokens = shlex.split(event.text)
            command_session_id = runner._session_key_for_source(event.source)
            if tokens[0] == "/model":
                selected = {
                    "model": tokens[1],
                    "provider": tokens[tokens.index("--provider") + 1],
                }
                await session_db.update_session_model(
                    session_entry.session_id, selected["model"]
                )
                runner._session_model_overrides[command_session_id] = selected
                await store.set_model_override(command_session_id, selected)
                store.fail_restore = True
                return "hidden"
            raise RuntimeError("reasoning command failed")

        self.adapter.gateway_runner = runner
        self.adapter._message_handler = handler
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-partial-durable-rollback",
                "threadId": thread_id,
                "sessionId": session_id,
                "turnId": "turn-partial-durable-rollback",
                "text": "Must not run",
                "modelSelection": {
                    "mode": "specific",
                    "provider": "openai-codex",
                    "model": "gpt-5.4",
                },
                "reasoningEffort": "high",
            }
        )

        self.assertEqual(store.restore_attempts, 1)
        self.assertEqual(session_db.row, prior_db_row)
        self.assertEqual(
            session_db.calls,
            [
                ("model", "gpt-5.4"),
                ("model", "old-model"),
                ("meta", prior_db_row["model_config"], "old-model"),
                ("prompt", prior_db_row["system_prompt"]),
            ],
        )
        self.assertEqual(
            runner._session_model_overrides, {session_id: prior_model}
        )
        error = self.connection.messages[-1]
        self.assertEqual(error["type"], "protocol.error")
        self.assertEqual(error["code"], "invalid-message")
        self.assertIn("session routing override", error["message"])

    async def test_failed_reasoning_does_not_rollback_a_later_session(self):
        first_thread = "thread-overlap-first"
        second_thread = "thread-overlap-second"
        first_session = await self._ensure_thread(first_thread)
        second_session = await self._ensure_thread(second_thread)
        runner = FakeGatewayRunner()
        runner._reasoning_config = {"enabled": True, "effort": "medium"}
        first_mutated = asyncio.Event()
        release_first = asyncio.Event()

        async def handler(event):
            effort = shlex.split(event.text)[1]
            session_id = runner._session_key_for_source(event.source)
            selected = {"enabled": True, "effort": effort}
            runner._reasoning_config = dict(selected)
            runner._session_reasoning_overrides[session_id] = dict(selected)
            if event.source.chat_id == first_thread:
                first_mutated.set()
                await release_first.wait()
                raise RuntimeError("first reasoning command failed")
            return "hidden"

        self.adapter.gateway_runner = runner
        self.adapter._message_handler = handler

        def start_message(thread_id, session_id, effort):
            return {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": f"start-{thread_id}",
                "threadId": thread_id,
                "sessionId": session_id,
                "turnId": f"turn-{thread_id}",
                "text": "Run",
                "reasoningEffort": effort,
            }

        first = asyncio.create_task(
            self.adapter._handle_server_frame(
                start_message(first_thread, first_session, "high")
            )
        )
        await asyncio.wait_for(first_mutated.wait(), timeout=1)

        second = asyncio.create_task(
            self.adapter._handle_server_frame(
                start_message(second_thread, second_session, "low")
            )
        )
        # The second task is queued before the first is released. Without a
        # cross-thread configuration fence it commits `low` first, then the
        # first task's rollback incorrectly overwrites that success.
        asyncio.get_running_loop().call_soon(release_first.set)
        await asyncio.gather(first, second)

        self.assertEqual(
            runner._reasoning_config, {"enabled": True, "effort": "low"}
        )
        self.assertNotIn(first_session, runner._session_reasoning_overrides)
        self.assertEqual(
            runner._session_reasoning_overrides[second_session],
            {"enabled": True, "effort": "low"},
        )
        self.assertNotIn(first_thread, self.adapter._active_turns)
        self.assertIn(second_thread, self.adapter._active_turns)

    async def test_reasoning_rollback_does_not_clobber_foreign_global_config(self):
        """Global `_reasoning_config` is restored only while this turn owns it.

        Session-scoped overrides still roll back. If something else rewrites the
        runner-wide mirror after our dispatch (and before we restore), leave that
        newer value alone instead of replaying this turn's preimage.
        """
        thread_id = "thread-foreign-reasoning-config"
        session_id = await self._ensure_thread(thread_id)
        runner = FakeGatewayRunner()
        prior_reasoning = {"enabled": True, "effort": "medium"}
        runner._reasoning_config = dict(prior_reasoning)
        runner._session_reasoning_overrides[session_id] = dict(prior_reasoning)
        foreign_reasoning = {"enabled": True, "effort": "low"}

        async def handler(event):
            del event
            selected = {"enabled": True, "effort": "high"}
            runner._reasoning_config = dict(selected)
            runner._session_reasoning_overrides[session_id] = dict(selected)
            return "hidden"

        original_effective = self.adapter._effective_reasoning_effort

        def effective_then_foreign(runner_arg, key, *, model=""):
            original_effective(runner_arg, key, model=model)
            # A later writer lands between ownership capture and rollback.
            runner_arg._reasoning_config = dict(foreign_reasoning)
            raise adapter_module._TurnConfigurationError(
                "verification failed after a foreign reasoning write"
            )

        self.adapter.gateway_runner = runner
        self.adapter._message_handler = handler
        self.adapter._effective_reasoning_effort = effective_then_foreign

        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-foreign-reasoning",
                "threadId": thread_id,
                "sessionId": session_id,
                "turnId": "turn-foreign-reasoning",
                "text": "Must not run",
                "reasoningEffort": "high",
            }
        )

        # Session-scoped state rolls back; the foreign global write is preserved.
        self.assertEqual(
            runner._session_reasoning_overrides, {session_id: prior_reasoning}
        )
        self.assertEqual(runner._reasoning_config, foreign_reasoning)
        self.assertNotIn(thread_id, self.adapter._active_turns)
        error = self.connection.messages[-1]
        self.assertEqual(error["type"], "protocol.error")
        self.assertIn("foreign reasoning write", error["message"])

    async def test_cancelled_configuration_restores_prior_state(self):
        thread_id = "thread-cancelled-config"
        session_id = await self._ensure_thread(thread_id)
        runner = FakeGatewayRunner()
        configuration_mutated = asyncio.Event()
        session_entry = types.SimpleNamespace(
            session_id="cancelled-durable-session",
            was_auto_reset=True,
        )

        class FakeAsyncSessionStore:
            def __init__(self):
                self.model_overrides = {}

            async def get_or_create_session(self, source):
                del source
                return session_entry

            async def get_model_override(self, key):
                return self.model_overrides.get(key)

            async def set_model_override(self, key, value):
                if value is None:
                    self.model_overrides.pop(key, None)
                else:
                    self.model_overrides[key] = dict(value)

        prior_db_row = {
            "model": None,
            "model_config": '{"browser_model_lock":"old-browser-model"}',
            "system_prompt": "prior nullable-model prompt",
        }

        class FakeSessionDB:
            def __init__(self):
                self.rows = {session_entry.session_id: dict(prior_db_row)}

            async def get_session(self, key):
                return dict(self.rows[key])

            async def update_session_model(self, key, model):
                row = self.rows[key]
                row["model"] = model
                row["model_config"] = None
                row["system_prompt"] = None

            async def update_session_meta(self, key, model_config, model=None):
                row = self.rows[key]
                row["model_config"] = model_config
                if model is not None:
                    row["model"] = model

            async def update_system_prompt(self, key, system_prompt):
                self.rows[key]["system_prompt"] = system_prompt

        runner.async_session_store = FakeAsyncSessionStore()
        runner._session_db = FakeSessionDB()
        cached_agent = types.SimpleNamespace(model="old-model")
        cached_entry = (cached_agent, "prior-cache-signature")
        runner._agent_cache = {session_id: cached_entry}
        runner._agent_cache_lock = None

        async def handler(event):
            tokens = shlex.split(event.text)
            command_session_id = runner._session_key_for_source(event.source)
            cached = runner._agent_cache.get(command_session_id)
            if cached is not None:
                cached[0].model = tokens[1]
            durable_entry = await runner.async_session_store.get_or_create_session(
                event.source
            )
            durable_entry.was_auto_reset = False
            await runner._session_db.update_session_model(
                durable_entry.session_id, tokens[1]
            )
            runner._session_model_overrides[command_session_id] = {
                "model": tokens[1],
                "provider": tokens[tokens.index("--provider") + 1],
            }
            if not hasattr(runner, "_pending_model_notes"):
                runner._pending_model_notes = {}
            runner._pending_model_notes[command_session_id] = "new model note"
            await runner.async_session_store.set_model_override(
                command_session_id,
                runner._session_model_overrides[command_session_id],
            )
            runner._agent_cache.pop(command_session_id, None)
            configuration_mutated.set()
            await asyncio.Event().wait()

        self.adapter.gateway_runner = runner
        self.adapter._message_handler = handler
        start = asyncio.create_task(
            self.adapter._handle_server_frame(
                {
                    "type": "turn.start",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": "start-cancelled-config",
                    "threadId": thread_id,
                    "sessionId": session_id,
                    "turnId": "turn-cancelled-config",
                    "text": "Must not run",
                    "modelSelection": {
                        "mode": "specific",
                        "provider": "openai-codex",
                        "model": "gpt-5.4",
                    },
                }
            )
        )
        await asyncio.wait_for(configuration_mutated.wait(), timeout=1)

        start.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await start

        self.assertEqual(runner._session_model_overrides, {})
        self.assertEqual(runner._session_reasoning_overrides, {})
        self.assertFalse(hasattr(runner, "_pending_model_notes"))
        self.assertEqual(runner.async_session_store.model_overrides, {})
        self.assertTrue(session_entry.was_auto_reset)
        self.assertEqual(
            runner._session_db.rows,
            {session_entry.session_id: prior_db_row},
        )
        self.assertIs(runner._agent_cache[session_id], cached_entry)
        self.assertEqual(cached_agent.model, "old-model")
        self.assertNotIn(thread_id, self.adapter._applied_turn_configuration)
        self.assertNotIn(thread_id, self.adapter._turn_start_reservations)
        self.assertNotIn(thread_id, self.adapter._active_turns)

    async def test_configuration_cache_is_idempotent_and_isolated_per_thread(self):
        runner, commands, _ = self._install_configuration_handler()

        async def start(thread_id: str, turn_id: str) -> str:
            session_id = self.adapter._sessions.get(thread_id)
            if session_id is None:
                session_id = await self._ensure_thread(thread_id)
            await self.adapter._handle_server_frame(
                {
                    "type": "turn.start",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": f"start-{turn_id}",
                    "threadId": thread_id,
                    "sessionId": session_id,
                    "turnId": turn_id,
                    "text": "Run",
                    "modelSelection": {
                        "mode": "specific",
                        "provider": "openai-codex",
                        "model": "gpt-5.4",
                    },
                    "reasoningEffort": "medium",
                }
            )
            return session_id

        first_session = await start("thread-cache-a", "turn-a1")
        await self.adapter.send(
            "thread-cache-a", "done", metadata={"notify": True}
        )
        cached_agent = types.SimpleNamespace(model="gpt-5.4")
        cached_entry = (cached_agent, "verified-cache-signature")
        runner._agent_cache = {first_session: cached_entry}
        runner._agent_cache_lock = None
        evicted = []

        def evict_cached_agent(key):
            evicted.append(runner._agent_cache.pop(key, None))

        runner._evict_cached_agent = evict_cached_agent
        await start("thread-cache-a", "turn-a2")
        # The runner still matches the cached verified state: no repeat
        # control commands or agent eviction for another turn in the same
        # session.
        self.assertEqual(len(commands), 2)
        self.assertIs(runner._agent_cache[first_session], cached_entry)
        self.assertEqual(evicted, [])
        await self.adapter.send(
            "thread-cache-a", "done again", metadata={"notify": True}
        )

        second_session = await start("thread-cache-b", "turn-b1")
        self.assertEqual(len(commands), 4)
        self.assertNotEqual(first_session, second_session)
        self.assertEqual(
            set(runner._session_model_overrides),
            {first_session, second_session},
        )

    async def test_busy_turn_rejects_configuration_without_mutating_it(self):
        session_id = await self._ensure_thread("thread-busy-config")
        runner, commands, _ = self._install_configuration_handler()
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-busy-first",
                "threadId": "thread-busy-config",
                "sessionId": session_id,
                "turnId": "turn-busy-first",
                "text": "First",
            }
        )

        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-busy-second",
                "threadId": "thread-busy-config",
                "sessionId": session_id,
                "turnId": "turn-busy-second",
                "text": "Second",
                "modelSelection": {
                    "mode": "specific",
                    "provider": "openai-codex",
                    "model": "gpt-5.4",
                },
                "reasoningEffort": "high",
            }
        )

        self.assertEqual(commands, [])
        self.assertEqual(runner._session_model_overrides, {})
        error = self.connection.messages[-1]
        self.assertEqual(error["type"], "protocol.error")
        self.assertEqual(error["requestId"], "start-busy-second")

    async def test_steer_ignores_model_and_reasoning_fields(self):
        session_id = await self._ensure_thread("thread-steer-config")
        runner, commands, _ = self._install_configuration_handler()
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-steer-config",
                "threadId": "thread-steer-config",
                "sessionId": session_id,
                "turnId": "turn-steer-config",
                "text": "Start",
            }
        )
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "steer-config",
                "threadId": "thread-steer-config",
                "sessionId": session_id,
                "turnId": "turn-steer-config",
                "text": "Focus",
                "modelSelection": {
                    "mode": "specific",
                    "provider": "openai-codex",
                    "model": "gpt-5.4",
                },
                "reasoningEffort": "high",
            }
        )

        self.assertEqual(commands, ["/steer Focus"])
        self.assertEqual(runner._session_model_overrides, {})
        self.assertEqual(runner._session_reasoning_overrides, {})

    async def test_tool_progress_bubble_edits_never_complete_the_turn(self):
        """Regression: the gateway's progress loop must not end a T3 turn.

        This is the defect this plugin shipped with. Declaring
        ``REQUIRES_EDIT_FINALIZE = True`` makes the gateway's tool-progress
        loop pass ``finalize=True`` on EVERY progress-bubble edit
        (``gateway/run.py:20777-20780`` at upstream 62e07223) — it is a
        presentation hint for rich-card surfaces, not a turn boundary.
        Treating it as "turn finished" closed the T3 turn on the first tool
        call; every later send then failed with "no active T3 turn" and the
        real answer never reached the transcript. The turn ends on exactly one
        signal: ``notify=True`` metadata on ``send``, which the gateway applies
        via ``_mark_notify_metadata`` (``gateway/platforms/base.py:89``) only
        for genuine user-visible replies.
        """
        # Declaring the flag is what arms the gateway's finalize-on-every-edit
        # branch, so the declaration itself is part of the contract under test.
        # It is NOT sufficient on its own: the stream consumer also passes
        # finalize=True on every mid-turn segment break regardless of the flag
        # (`gateway/stream_consumer.py:938-940`), which is why `edit_message`
        # must ignore `finalize` outright — see the segment-break leg below.
        self.assertFalse(self.adapter.REQUIRES_EDIT_FINALIZE)

        await self._start_turn("thread-progress", "turn-progress")
        turn = self.adapter._active_turns["thread-progress"]
        progress_start = len(self.connection.messages)

        # Progress metadata is thread/routing metadata only; the progress loop
        # never marks it notify-worthy (verified: zero _mark_notify_metadata
        # calls in gateway/run.py:20700-20960).
        progress_metadata = {"thread_id": "thread-progress"}

        async def edit_progress_message(message_id: str, content: str):
            """Mirror of the gateway's `_edit_progress_message` closure."""
            kwargs = {
                "chat_id": "thread-progress",
                "message_id": message_id,
                "content": content,
            }
            if getattr(self.adapter, "REQUIRES_EDIT_FINALIZE", False):
                kwargs["finalize"] = True
            kwargs["metadata"] = progress_metadata
            return await self.adapter.edit_message(**kwargs)

        # First progress bubble is a plain send, never notify-marked.
        first = await self.adapter.send(
            "thread-progress",
            "📚 Reading skill hermes-agent",
            reply_to=None,
            metadata=progress_metadata,
        )
        self.assertTrue(first.success)
        self.assertIn("thread-progress", self.adapter._active_turns)

        # Then the loop edits that one bubble once per tool event.
        progress_lines = ["📚 Reading skill hermes-agent"]
        for line in (
            "🔍 Searching the web for hermes gateway",
            "📖 Reading file gateway/run.py",
            "🛠️ Running tests",
        ):
            progress_lines.append(line)
            result = await edit_progress_message(
                first.message_id, "\n".join(progress_lines)
            )
            self.assertTrue(result.success)
            # Every single edit must leave the turn running.
            self.assertIn("thread-progress", self.adapter._active_turns)
            self.assertIs(self.adapter._active_turns["thread-progress"], turn)

        self.assertNotIn(
            "turn.completed",
            [message["type"] for message in self.connection.messages],
        )

        # Second, flag-independent leg: the stream consumer finalizes the
        # current content message at every tool/segment boundary
        # (`gateway/stream_consumer.py:938-940` passes
        # `finalize=(got_done or got_segment_break)`), and it does so whether
        # or not the adapter declares REQUIRES_EDIT_FINALIZE. A mid-turn
        # segment break is not a turn boundary either.
        for partial in ("Let me check the docs.", "Let me check the docs. Found it."):
            segment = await self.adapter.edit_message(
                "thread-progress",
                first.message_id,
                partial,
                finalize=True,
                metadata=progress_metadata,
            )
            self.assertTrue(segment.success)
            self.assertIn("thread-progress", self.adapter._active_turns)
        self.assertNotIn(
            "turn.completed",
            [message["type"] for message in self.connection.messages],
        )

        # Now the real answer arrives as the gateway's notify-marked final
        # send. That — and only that — closes the turn, exactly once.
        answer = await self.adapter.send(
            "thread-progress",
            "\n".join(progress_lines) + "\nHere is the real answer.",
            metadata={"notify": True},
        )
        self.assertTrue(answer.success)
        self.assertNotIn("thread-progress", self.adapter._active_turns)
        self.assertEqual(
            [
                message["type"]
                for message in self.connection.messages[progress_start:]
                if message["type"] == "turn.completed"
            ],
            ["turn.completed"],
        )

        # A late finalize edit after completion cannot resurrect or re-close
        # the turn; it fails closed with the "no active turn" result.
        late = await edit_progress_message(first.message_id, "late progress")
        self.assertFalse(late.success)
        self.assertEqual(late.error, "no active T3 turn")
        self.assertEqual(
            len(
                [
                    message
                    for message in self.connection.messages
                    if message["type"] == "turn.completed"
                ]
            ),
            1,
        )

    async def test_cumulative_edits_emit_delta_snapshot_delta_then_finalize(self):
        await self._start_turn("thread-snapshot", "turn-snapshot")
        content_start = len(self.connection.messages)

        await self.adapter.send("thread-snapshot", "Hello")
        duplicate_start = len(self.connection.messages)
        await self.adapter.edit_message("thread-snapshot", "message", "Hello")
        self.assertEqual(len(self.connection.messages), duplicate_start)

        await self.adapter.edit_message("thread-snapshot", "message", "Help")
        snapshot_duplicate_start = len(self.connection.messages)
        await self.adapter.edit_message("thread-snapshot", "message", "Help")
        self.assertEqual(len(self.connection.messages), snapshot_duplicate_start)

        await self.adapter.edit_message(
            "thread-snapshot",
            "message",
            "Helpful",
            finalize=True,
        )
        # `finalize` is inert; the notify send is what closes the turn.
        await self.adapter.send("thread-snapshot", "Helpful", metadata={"notify": True})

        content_frames = self.connection.messages[content_start:]
        self.assertEqual(
            [message["type"] for message in content_frames],
            [
                "item.started",
                "content.delta",
                "content.snapshot",
                "content.delta",
                "item.completed",
                "turn.completed",
                "connection.status",
            ],
        )
        self.assertEqual(content_frames[1]["delta"], "Hello")
        self.assertEqual(content_frames[2]["text"], "Help")
        self.assertEqual(content_frames[3]["delta"], "ful")

    async def test_empty_and_duplicate_cumulative_edits_are_reconciled(self):
        await self._start_turn("thread-empty", "turn-empty")
        content_start = len(self.connection.messages)

        await self.adapter.send("thread-empty", "")
        duplicate_start = len(self.connection.messages)
        await self.adapter.edit_message("thread-empty", "message", "")
        self.assertEqual(len(self.connection.messages), duplicate_start)

        await self.adapter.edit_message("thread-empty", "message", "Visible")
        await self.adapter.edit_message("thread-empty", "message", "")
        empty_snapshot_end = len(self.connection.messages)
        await self.adapter.edit_message("thread-empty", "message", "")
        self.assertEqual(len(self.connection.messages), empty_snapshot_end)
        await self.adapter.edit_message(
            "thread-empty",
            "message",
            "",
            finalize=True,
        )
        await self.adapter.send("thread-empty", "", metadata={"notify": True})

        content_frames = self.connection.messages[content_start:]
        self.assertEqual(
            [message["type"] for message in content_frames],
            [
                "item.started",
                "content.delta",
                "content.snapshot",
                "item.completed",
                "turn.completed",
                "connection.status",
            ],
        )
        self.assertEqual(content_frames[1]["delta"], "Visible")
        self.assertEqual(content_frames[2]["text"], "")

    async def test_failed_content_sends_do_not_advance_visible_text(self):
        await self._start_turn("thread-retry", "turn-retry")
        await self.adapter.send("thread-retry", "Hello")
        original_send = self.connection.send

        async def fail_content(message):
            if message["type"] in {"content.delta", "content.snapshot"}:
                raise ConnectionError("send failed")
            await original_send(message)

        self.connection.send = fail_content
        failed = await self.adapter.edit_message(
            "thread-retry",
            "message",
            "Hello world",
        )
        self.assertFalse(failed.success)
        self.assertEqual(
            self.adapter._active_turns["thread-retry"].visible_text,
            "Hello",
        )

        self.connection.send = original_send
        retried = await self.adapter.edit_message(
            "thread-retry",
            "message",
            "Hello world",
        )
        self.assertTrue(retried.success)
        self.assertEqual(self.connection.messages[-1]["delta"], " world")

        self.connection.send = fail_content
        failed_snapshot = await self.adapter.edit_message(
            "thread-retry",
            "message",
            "Hi",
        )
        self.assertFalse(failed_snapshot.success)
        self.assertEqual(
            self.adapter._active_turns["thread-retry"].visible_text,
            "Hello world",
        )

        self.connection.send = original_send
        retried_snapshot = await self.adapter.edit_message(
            "thread-retry",
            "message",
            "Hi",
        )
        self.assertTrue(retried_snapshot.success)
        self.assertEqual(self.connection.messages[-1]["type"], "content.snapshot")
        self.assertEqual(self.connection.messages[-1]["text"], "Hi")

    async def test_failed_generic_activity_start_retries_the_full_lifecycle(self):
        await self._start_turn("thread-activity-retry", "turn-activity-retry")
        turn = self.adapter._active_turns["thread-activity-retry"]
        original_send = self.connection.send

        async def fail_activity_start(message):
            if message["type"] == "item.started":
                raise ConnectionError("send failed")
            await original_send(message)

        self.connection.send = fail_activity_start
        with self.assertRaisesRegex(ConnectionError, "send failed"):
            await self.adapter._emit_generic_activity(turn, "Reading repository")

        self.assertIsNone(turn.generic_activity_id)
        self.assertIsNone(turn.generic_activity_detail)

        self.connection.send = original_send
        await self.adapter._emit_generic_activity(turn, "Reading repository")
        started = self.connection.messages[-1]
        self.assertEqual(started["type"], "item.started")
        self.assertEqual(started["detail"], "Reading repository")
        self.assertEqual(turn.generic_activity_id, started["itemId"])
        self.assertEqual(turn.generic_activity_detail, "Reading repository")

        await self.adapter._emit_generic_activity(turn, "Running tests")
        updated = self.connection.messages[-1]
        self.assertEqual(updated["type"], "item.updated")
        self.assertEqual(updated["itemId"], started["itemId"])
        self.assertEqual(updated["detail"], "Running tests")

    async def test_live_status_uses_status_text_not_the_unknown_sentinel(self):
        await self._start_turn("thread-status-type", "turn-status-type")
        turn = self.adapter._active_turns["thread-status-type"]

        await self.adapter._emit_generic_activity(turn, "Reading repository")
        await self.adapter._emit_generic_activity(turn, "Running tests")
        await self.adapter._complete_turn(turn)

        status_frames = [
            message
            for message in self.connection.messages
            if message.get("itemId") == turn.generic_activity_id
        ]
        self.assertEqual(
            [message["type"] for message in status_frames],
            ["item.started", "item.updated", "item.completed"],
        )
        # `unknown` is the canonical "could not classify" sentinel other
        # adapters rely on being inert; status lines get their own type.
        self.assertEqual(
            {message["itemType"] for message in status_frames},
            {"status_text"},
        )
        # T3 renders these rows preferring `detail`, so the real status string
        # must ride there rather than only in `title`.
        self.assertEqual(status_frames[0]["detail"], "Reading repository")
        self.assertEqual(status_frames[1]["detail"], "Running tests")
        self.assertEqual(status_frames[2]["detail"], "Running tests")

    async def test_concurrent_generic_activity_updates_share_one_lifecycle(self):
        await self._start_turn("thread-activity-concurrent", "turn-activity-concurrent")
        turn = self.adapter._active_turns["thread-activity-concurrent"]
        original_send = self.connection.send
        first_send_started = asyncio.Event()
        release_first_send = asyncio.Event()

        async def block_first_activity_send(message):
            if message["type"] == "item.started" and not first_send_started.is_set():
                first_send_started.set()
                await release_first_send.wait()
            await original_send(message)

        self.connection.send = block_first_activity_send
        first_update = asyncio.create_task(
            self.adapter._emit_generic_activity(turn, "Reading repository")
        )
        await first_send_started.wait()
        second_update = asyncio.create_task(
            self.adapter._emit_generic_activity(turn, "Running tests")
        )
        await asyncio.sleep(0)
        release_first_send.set()
        await asyncio.gather(first_update, second_update)

        activity_frames = [
            message
            for message in self.connection.messages
            if message["type"] in {"item.started", "item.updated"}
        ]
        self.assertEqual(
            [message["type"] for message in activity_frames],
            ["item.started", "item.updated"],
        )
        self.assertEqual(activity_frames[0]["itemId"], activity_frames[1]["itemId"])
        self.assertEqual(turn.generic_activity_id, activity_frames[0]["itemId"])
        self.assertEqual(turn.generic_activity_detail, "Running tests")

    async def test_turn_completion_waits_for_in_flight_generic_activity_update(self):
        await self._start_turn("thread-activity-complete", "turn-activity-complete")
        turn = self.adapter._active_turns["thread-activity-complete"]
        await self.adapter._emit_generic_activity(turn, "Reading repository")
        activity_id = turn.generic_activity_id
        original_send = self.connection.send
        update_send_started = asyncio.Event()
        release_update_send = asyncio.Event()

        async def block_activity_update(message):
            if message["type"] == "item.updated":
                update_send_started.set()
                await release_update_send.wait()
            await original_send(message)

        self.connection.send = block_activity_update
        in_flight_update = asyncio.create_task(
            self.adapter._emit_generic_activity(turn, "Running tests")
        )
        await update_send_started.wait()
        completion = asyncio.create_task(self.adapter._complete_turn(turn))
        await asyncio.sleep(0)
        self.assertFalse(completion.done())

        release_update_send.set()
        await asyncio.gather(in_flight_update, completion)

        lifecycle_frames = [
            message
            for message in self.connection.messages
            if message["type"]
            in {"item.started", "item.updated", "item.completed", "turn.completed"}
        ]
        self.assertEqual(
            [message["type"] for message in lifecycle_frames],
            ["item.started", "item.updated", "item.completed", "turn.completed"],
        )
        self.assertTrue(
            all(
                message["itemId"] == activity_id
                for message in lifecycle_frames
                if message["type"].startswith("item.")
            )
        )
        self.assertNotIn("thread-activity-complete", self.adapter._active_turns)

    def test_home_channel_notice_literal_matches_hermes_construction(self):
        # Hermes builds this notice inline from an f-string rather than
        # exporting a constant (gateway/run.py:13780 at upstream 62e07223), and
        # the adapter suppresses it by exact string equality. Reconstruct it the
        # same way so upstream wording drift fails here loudly instead of
        # leaking the notice into a T3 transcript.
        platform_name = "t3"  # Platform("t3").value
        sethome_cmd = "/sethome"  # non-Slack branch
        expected = (
            f"📬 No home channel is set for {platform_name.title()}. "
            f"A home channel is where Hermes delivers cron job results "
            f"and cross-platform messages.\n\n"
            f"Type {sethome_cmd} to make this chat your home channel, "
            f"or ignore to skip."
        )
        self.assertEqual(adapter_module._T3_HOME_CHANNEL_NOTICE, expected)

    async def test_exact_t3_home_channel_notice_is_suppressed(self):
        await self._start_turn("thread-notice", "turn-notice")
        content_start = len(self.connection.messages)
        notice = (
            "📬 No home channel is set for T3. "
            "A home channel is where Hermes delivers cron job results "
            "and cross-platform messages.\n\n"
            "Type /sethome to make this chat your home channel, or ignore to skip."
        )

        suppressed = await self.adapter.send("thread-notice", notice)
        self.assertTrue(suppressed.success)
        self.assertEqual(len(self.connection.messages), content_start)
        self.assertFalse(
            self.adapter._active_turns["thread-notice"].assistant_started
        )

        await self.adapter.edit_message(
            "thread-notice",
            "message",
            "The actual Hermes response",
            finalize=True,
        )
        await self.adapter.send(
            "thread-notice",
            "The actual Hermes response",
            metadata={"notify": True},
        )
        content_frames = self.connection.messages[content_start:]
        self.assertEqual(
            [message["type"] for message in content_frames],
            [
                "item.started",
                "content.delta",
                "item.completed",
                "turn.completed",
                "connection.status",
            ],
        )
        self.assertEqual(content_frames[1]["delta"], "The actual Hermes response")

    async def test_terminal_send_suppresses_exact_home_notice_and_completes_turn(self):
        await self._start_turn("thread-terminal-notice-send", "turn-terminal-notice-send")
        content_start = len(self.connection.messages)
        notice = (
            "📬 No home channel is set for T3. "
            "A home channel is where Hermes delivers cron job results "
            "and cross-platform messages.\n\n"
            "Type /sethome to make this chat your home channel, or ignore to skip."
        )

        suppressed = await self.adapter.send(
            "thread-terminal-notice-send",
            notice,
            metadata={"notify": True},
        )

        self.assertTrue(suppressed.success)
        self.assertNotIn("thread-terminal-notice-send", self.adapter._active_turns)
        self.assertEqual(
            [
                message["type"]
                for message in self.connection.messages[content_start:]
            ],
            ["turn.completed", "connection.status"],
        )

    async def test_edit_of_exact_home_notice_is_suppressed_without_completing(self):
        await self._start_turn("thread-terminal-notice-edit", "turn-terminal-notice-edit")
        content_start = len(self.connection.messages)
        notice = (
            "📬 No home channel is set for T3. "
            "A home channel is where Hermes delivers cron job results "
            "and cross-platform messages.\n\n"
            "Type /sethome to make this chat your home channel, or ignore to skip."
        )

        suppressed = await self.adapter.edit_message(
            "thread-terminal-notice-edit",
            "message",
            notice,
            finalize=True,
        )

        self.assertTrue(suppressed.success)
        # The notice is still swallowed, but an edit — even a `finalize` one —
        # no longer ends the turn: the progress loop sets `finalize` on every
        # progress bubble, so acting on it truncated real turns.
        self.assertIn("thread-terminal-notice-edit", self.adapter._active_turns)
        self.assertEqual(self.connection.messages[content_start:], [])

    async def test_near_match_home_channel_text_is_not_suppressed(self):
        await self._start_turn("thread-notice-near-match", "turn-notice-near-match")
        content_start = len(self.connection.messages)
        await self.adapter.edit_message(
            "thread-notice-near-match",
            "message",
            (
                "📬 No home channel is set for T3. "
                "A home channel is where Hermes delivers cron job results "
                "and cross-platform messages.\n\n"
                "Type /sethome to make this chat your home channel, "
                "or ignore to skip. "
            ),
            finalize=True,
        )
        await self.adapter.send(
            "thread-notice-near-match", "done", metadata={"notify": True}
        )
        self.assertEqual(
            [
                message["type"]
                for message in self.connection.messages[content_start:]
            ],
            [
                "item.started",
                "content.delta",
                "content.snapshot",
                "item.completed",
                "turn.completed",
                "connection.status",
            ],
        )

    async def test_session_ready_reports_an_active_turn_on_reconnect(self):
        session_id = await self._start_turn("thread-reconnect", "turn-reconnect")

        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "ensure-reconnect",
                "threadId": "thread-reconnect",
                "resumeSessionId": session_id,
            }
        )

        ready = self.connection.messages[-2]
        self.assertEqual(ready["type"], "session.ready")
        self.assertTrue(ready["resumed"])
        self.assertEqual(ready["activeTurnId"], "turn-reconnect")

    async def test_steer_uses_official_hermes_command(self):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "ensure-2",
                "threadId": "thread-2",
            }
        )
        session_id = self.adapter._sessions["thread-2"]
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-2",
                "threadId": "thread-2",
                "sessionId": session_id,
                "turnId": "turn-2",
                "text": "Start",
            }
        )
        messages_before_steer = len(self.connection.messages)

        async def accept_steer(_event):
            return (
                "⏩ Steer queued — arrives after the next tool call: 'Focus on tests'"
            )

        self.adapter._message_handler = accept_steer
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "steer-2",
                "threadId": "thread-2",
                "sessionId": session_id,
                "turnId": "turn-2",
                "text": "Focus on tests",
            }
        )
        self.assertEqual(self.adapter.messages[-1].text, "/steer Focus on tests")
        self.assertEqual(self.adapter.messages[-1].message_type, MessageType.COMMAND)
        steer_messages = self.connection.messages[messages_before_steer:]
        self.assertEqual(
            [message["type"] for message in steer_messages], ["turn.started"]
        )
        self.assertEqual(steer_messages[0]["requestId"], "steer-2")
        self.assertIn("thread-2", self.adapter._active_turns)

        # A post-steer edit streams the real answer. `finalize` is inert — the
        # gateway sets it on every tool-progress edit — so the turn must stay
        # open until the notify-marked final send arrives.
        await self.adapter.edit_message(
            "thread-2",
            "message",
            "Actual response after steering",
            finalize=True,
        )
        deltas = [
            message["delta"]
            for message in self.connection.messages
            if message["type"] == "content.delta"
        ]
        self.assertEqual(deltas, ["Actual response after steering"])
        self.assertIn("thread-2", self.adapter._active_turns)
        self.assertNotIn(
            "turn.completed", [m["type"] for m in self.connection.messages]
        )

        await self.adapter.send(
            "thread-2",
            "Actual response after steering",
            metadata={"notify": True},
        )
        self.assertNotIn("thread-2", self.adapter._active_turns)
        self.assertEqual(
            [
                message["type"]
                for message in self.connection.messages
                if message["type"] == "turn.completed"
            ],
            ["turn.completed"],
        )

    async def test_assistant_output_during_a_steer_is_not_captured_as_control(self):
        session_id = await self._start_turn("thread-steer-race", "turn-steer-race")
        messages_before_steer = len(self.connection.messages)

        async def stream_while_steering(event):
            # A steer targets a RUNNING turn, so Hermes can emit genuine
            # assistant output on this same thread while the steering command
            # is still being awaited. That output must reach the transcript.
            await self.adapter.edit_message(
                "thread-steer-race",
                "hermes-stream-message",
                "Mid-steer assistant output",
            )
            del event
            return "⏩ Steer queued — arrives after the next tool call: 'Focus'"

        self.adapter._message_handler = stream_while_steering
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "steer-race",
                "threadId": "thread-steer-race",
                "sessionId": session_id,
                "turnId": "turn-steer-race",
                "text": "Focus",
            }
        )

        steer_messages = self.connection.messages[messages_before_steer:]
        self.assertEqual(
            [message["type"] for message in steer_messages],
            ["item.started", "content.delta", "turn.started"],
        )
        self.assertEqual(steer_messages[1]["delta"], "Mid-steer assistant output")
        # The acknowledgement itself is still captured and suppressed, so the
        # steer is acknowledged rather than failing closed on the prefix check.
        self.assertEqual(steer_messages[2]["requestId"], "steer-race")
        self.assertIn("thread-steer-race", self.adapter._active_turns)
        self.assertEqual(
            self.adapter._active_turns["thread-steer-race"].visible_text,
            "Mid-steer assistant output",
        )

    async def test_steer_control_acknowledgement_edits_stay_suppressed(self):
        session_id = await self._start_turn("thread-steer-edit", "turn-steer-edit")
        messages_before_steer = len(self.connection.messages)
        acknowledgement = "⏩ Steer queued — arrives after the next tool call: 'Focus'"

        async def edit_own_acknowledgement(event):
            sent = await self.adapter.send(
                "thread-steer-edit",
                acknowledgement,
                reply_to=event.message_id,
                metadata={"notify": True},
            )
            # A retry/finalize edit of the control message correlates by the
            # synthetic control message id, so it stays out of the transcript.
            await self.adapter.edit_message(
                "thread-steer-edit",
                sent.message_id,
                acknowledgement,
                finalize=True,
            )

        self.adapter._message_handler = edit_own_acknowledgement
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "steer-edit",
                "threadId": "thread-steer-edit",
                "sessionId": session_id,
                "turnId": "turn-steer-edit",
                "text": "Focus",
            }
        )

        steer_messages = self.connection.messages[messages_before_steer:]
        self.assertEqual(
            [message["type"] for message in steer_messages], ["turn.started"]
        )
        self.assertIn("thread-steer-edit", self.adapter._active_turns)

    async def test_rejected_steer_emits_error_without_completing_active_turn(self):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "ensure-rejected-steer",
                "threadId": "thread-rejected-steer",
            }
        )
        session_id = self.adapter._sessions["thread-rejected-steer"]
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-rejected-steer",
                "threadId": "thread-rejected-steer",
                "sessionId": session_id,
                "turnId": "turn-rejected-steer",
                "text": "Start",
            }
        )
        messages_before_steer = len(self.connection.messages)

        async def reject_steer(_event):
            return "Steer rejected (empty payload)."

        self.adapter._message_handler = reject_steer
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "steer-rejected",
                "threadId": "thread-rejected-steer",
                "sessionId": session_id,
                "turnId": "turn-rejected-steer",
                "text": "Focus on tests",
            }
        )

        # The core invariant: rejecting a steer reports an error and leaves the
        # running turn untouched. The rejection must emit exactly the error —
        # no turn lifecycle frame of any kind.
        steer_messages = self.connection.messages[messages_before_steer:]
        self.assertEqual(
            [message["type"] for message in steer_messages], ["protocol.error"]
        )
        self.assertEqual(steer_messages[0]["requestId"], "steer-rejected")
        self.assertEqual(steer_messages[0]["code"], "invalid-message")
        self.assertIn("thread-rejected-steer", self.adapter._active_turns)

        # The still-active turn keeps streaming. `finalize` on an edit is inert
        # (the gateway sets it on every progress bubble), so the turn survives.
        await self.adapter.edit_message(
            "thread-rejected-steer",
            "message",
            "Actual response after rejected steering",
            finalize=True,
        )
        self.assertEqual(self.connection.messages[-1]["type"], "content.delta")
        self.assertIn("thread-rejected-steer", self.adapter._active_turns)
        self.assertNotIn(
            "turn.completed", [m["type"] for m in self.connection.messages]
        )

        # Only the notify-marked final send ends it.
        await self.adapter.send(
            "thread-rejected-steer",
            "Actual response after rejected steering",
            metadata={"notify": True},
        )
        self.assertEqual(self.connection.messages[-1]["type"], "connection.status")
        self.assertNotIn("thread-rejected-steer", self.adapter._active_turns)

    async def test_failed_steer_emits_correlated_internal_error(self):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "ensure-failed-steer",
                "threadId": "thread-failed-steer",
            }
        )
        session_id = self.adapter._sessions["thread-failed-steer"]
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-failed-steer",
                "threadId": "thread-failed-steer",
                "sessionId": session_id,
                "turnId": "turn-failed-steer",
                "text": "Start",
            }
        )
        messages_before_steer = len(self.connection.messages)

        async def fail_steer(_event):
            raise RuntimeError("running agent rejected steering")

        self.adapter._message_handler = fail_steer
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "steer-failed",
                "threadId": "thread-failed-steer",
                "sessionId": session_id,
                "turnId": "turn-failed-steer",
                "text": "Focus on tests",
            }
        )

        steer_messages = self.connection.messages[messages_before_steer:]
        self.assertEqual(
            [message["type"] for message in steer_messages], ["protocol.error"]
        )
        self.assertEqual(steer_messages[0]["requestId"], "steer-failed")
        self.assertEqual(steer_messages[0]["code"], "internal-error")
        self.assertIn("thread-failed-steer", self.adapter._active_turns)

    async def test_schedule_keeps_a_strong_reference_until_the_task_finishes(self):
        self.adapter._event_loop = asyncio.get_running_loop()
        released = asyncio.Event()

        async def work():
            await asyncio.sleep(0)
            released.set()

        self.adapter._schedule(work())
        self.assertEqual(len(self.adapter._scheduled_tasks), 1)
        await released.wait()
        await asyncio.sleep(0)
        self.assertEqual(self.adapter._scheduled_tasks, set())

    async def test_schedule_logs_background_task_failures(self):
        self.adapter._event_loop = asyncio.get_running_loop()

        async def boom():
            raise RuntimeError("background frame failed")

        with self.assertLogs(adapter_module.logger, level="ERROR") as captured:
            self.adapter._schedule(boom())
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        self.assertTrue(
            any("background frame failed" in line for line in captured.output)
        )
        self.assertEqual(self.adapter._scheduled_tasks, set())

    async def test_schedule_does_not_create_tasks_on_a_foreign_loop(self):
        other_loop = asyncio.new_event_loop()
        self.adapter._event_loop = other_loop

        async def work():
            return None

        coroutine = work()
        try:
            with (
                unittest.mock.patch.object(other_loop, "create_task") as create_task,
                unittest.mock.patch.object(
                    adapter_module.asyncio, "run_coroutine_threadsafe"
                ) as threadsafe,
            ):
                # The running loop is this test's loop, not the adapter's, so
                # create_task would schedule onto the wrong loop entirely.
                self.adapter._schedule(coroutine)
            create_task.assert_not_called()
            threadsafe.assert_called_once_with(coroutine, other_loop)
            self.assertEqual(self.adapter._scheduled_tasks, set())
        finally:
            coroutine.close()
            other_loop.close()

    async def test_schedule_closes_the_coroutine_when_the_loop_is_gone(self):
        self.adapter._event_loop = None
        started = False

        async def work():
            nonlocal started
            started = True

        coroutine = work()
        self.adapter._schedule(coroutine)
        self.assertFalse(started)
        self.assertEqual(self.adapter._scheduled_tasks, set())

    async def test_session_status_counts_ready_sessions_and_stop_decrements(self):
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "ensure-3",
                "threadId": "thread-3",
            }
        )
        session_id = self.adapter._sessions["thread-3"]
        self.assertEqual(self.connection.messages[-1]["activeSessionCount"], 1)
        await self.adapter._handle_server_frame(
            {
                "type": "session.stop",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "stop-3",
                "threadId": "thread-3",
                "sessionId": session_id,
            }
        )
        self.assertEqual(self.connection.messages[-1]["type"], "connection.status")
        self.assertEqual(self.connection.messages[-1]["activeSessionCount"], 0)
        self.assertEqual(self.adapter._sessions["thread-3"], session_id)

    async def test_describe_request_replies_with_the_requests_own_id(self):
        with unittest.mock.patch.object(
            adapter_module, "_hermes_version", return_value="0.19.0"
        ), unittest.mock.patch.object(
            adapter_module,
            "describe_response",
            wraps=adapter_module.describe_response,
        ) as describe:
            await self.adapter._handle_server_frame(
                {
                    "type": "describe.request",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": "describe-1",
                }
            )

        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "describe.response")
        # Correlation, exactly like ping -> pong.
        self.assertEqual(reply["requestId"], "describe-1")
        self.assertEqual(
            reply["protocolVersion"], protocol_module.PROTOCOL_VERSION
        )
        self.assertEqual(reply["hermesVersion"], "0.19.0")
        self.assertIsInstance(reply["skills"], list)
        self.assertIn("capabilities", reply)
        self.assertEqual(describe.call_count, 1)

    async def test_models_list_request_builds_catalog_off_the_event_loop(self):
        catalog = {
            "currentProvider": "openai-codex",
            "currentModel": "gpt-5.4",
            "currentReasoningEffort": "high",
            "models": [
                {
                    "provider": "openai-codex",
                    "providerName": "OpenAI Codex",
                    "model": "gpt-5.4",
                    "supportsReasoning": True,
                }
            ],
        }
        with unittest.mock.patch.object(
            adapter_module, "models_catalog"
        ) as build_catalog, unittest.mock.patch.object(
            adapter_module.asyncio,
            "to_thread",
            new=unittest.mock.AsyncMock(return_value=catalog),
        ) as to_thread:
            await self.adapter._handle_server_frame(
                {
                    "type": "models.list.request",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": "models-1",
                }
            )

        to_thread.assert_awaited_once_with(build_catalog)
        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "models.list.response")
        self.assertEqual(reply["requestId"], "models-1")
        self.assertEqual(reply["models"], catalog["models"])
        self.assertEqual(reply["currentReasoningEffort"], "high")

    async def test_describe_request_survives_hermes_being_unreadable(self):
        # An older Hermes whose modules exist but export none of the accessors
        # the plugin reads. The reply gets thinner; it never becomes an error
        # and never breaks the connection.
        with hermes_without_describe_surfaces():
            await self.adapter._handle_server_frame(
                {
                    "type": "describe.request",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": "describe-degraded",
                }
            )
        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "describe.response")
        self.assertEqual(reply["requestId"], "describe-degraded")
        self.assertNotIn("reasoningEffort", reply)
        self.assertNotIn("model", reply)
        self.assertEqual(reply["skills"], [])
        self.assertEqual(reply["pluginVersion"], protocol_module.PLUGIN_VERSION)

    async def test_skill_body_request_survives_hermes_being_unreadable(self):
        with hermes_without_describe_surfaces():
            await self.adapter._handle_server_frame(
                {
                    "type": "skill.body.request",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": "body-degraded",
                    "skillName": "codex",
                }
            )
        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "skill.body.response")
        self.assertEqual(reply["requestId"], "body-degraded")
        self.assertEqual(reply["skillName"], "codex")
        self.assertIsNone(reply["markdown"])

    async def test_skill_body_request_replies_with_correlated_markdown(self):
        with unittest.mock.patch.object(
            adapter_module, "skill_body", return_value="# Codex\n"
        ) as read_body:
            await self.adapter._handle_server_frame(
                {
                    "type": "skill.body.request",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": "body-1",
                    "skillName": "codex",
                }
            )

        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "skill.body.response")
        self.assertEqual(reply["requestId"], "body-1")
        self.assertEqual(reply["skillName"], "codex")
        self.assertEqual(reply["markdown"], "# Codex\n")
        read_body.assert_called_once_with("codex")

    async def test_skill_body_request_replies_null_for_an_unknown_skill(self):
        await self.adapter._handle_server_frame(
            {
                "type": "skill.body.request",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "body-2",
                "skillName": "does-not-exist",
            }
        )
        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "skill.body.response")
        self.assertEqual(reply["requestId"], "body-2")
        self.assertEqual(reply["skillName"], "does-not-exist")
        # Present but null, not an error the UI would have to render.
        self.assertIn("markdown", reply)
        self.assertIsNone(reply["markdown"])

    async def test_skill_body_request_without_a_name_is_a_correlated_error(self):
        # `skillName` is echoed back for the client to key on and is non-empty
        # on the wire, so a nameless request cannot be answered with a
        # response frame — it takes the ordinary protocol.error path.
        await self.adapter._handle_server_frame(
            {
                "type": "skill.body.request",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "body-3",
            }
        )
        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "protocol.error")
        self.assertEqual(reply["requestId"], "body-3")
        self.assertEqual(reply["code"], "unsupported-message")
        self.assertTrue(reply["recoverable"])

    async def test_describe_frames_never_emit_a_protocol_error(self):
        for message in (
            {
                "type": "describe.request",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "describe-no-error",
            },
            {
                "type": "skill.body.request",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "body-no-error",
                "skillName": "codex",
            },
        ):
            with self.subTest(frame_type=message["type"]):
                await self.adapter._handle_server_frame(message)
        self.assertNotIn(
            "protocol.error",
            [message["type"] for message in self.connection.messages],
        )

    def test_tool_progress_chrome_is_dropped(self):
        """Tool chrome is redundant with T3's typed activity items.

        T3 already renders tool calls as typed `item.started` /
        `item.completed` activity from the `pre_tool_call` / `post_tool_call`
        hooks, so a text line duplicating them is strictly worse.

        NOTE: this override is NOT what protects the turn. At Hermes 62e07223
        it is not even on the live path — its only caller,
        `GatewayEventDispatcher` (`gateway/stream_dispatch.py:108`), is
        referenced solely by upstream tests. The turn is protected by ignoring
        `finalize` in `edit_message`; see
        `test_tool_progress_bubble_edits_never_complete_the_turn`.
        """

        class _ToolCallChunk:
            tool_name = "skill_view"
            preview = "hermes-agent"
            args = {"name": "hermes-agent"}

        for mode in ("all", "new", "verbose"):
            with self.subTest(mode=mode):
                self.assertIsNone(
                    self.adapter.format_tool_event(_ToolCallChunk(), mode=mode)
                )

    async def test_tool_hooks_resolve_the_turn_from_the_gateway_session_key(self):
        """Tool hooks carry Hermes' run id, not this plugin's session id.

        `agent.session_id` (`agent/tool_executor.py:188`) is a timestamped run
        id like `20260725_143012_ab12cd34` (`gateway/session.py:2388`), while
        this plugin's session ids come from `build_session_key`
        (`agent:main:t3:dm:<thread>`). Keying `_thread_by_session` on the hook's
        value alone therefore never matches and silently drops every tool
        activity item. The gateway's stable routing key is available from
        `HERMES_SESSION_KEY` (`gateway/run.py:17367`), which IS the
        build_session_key value.
        """
        self.adapter._event_loop = asyncio.get_running_loop()
        session_id = await self._start_turn("thread-tools", "turn-tools")
        frames_before = len(self.connection.messages)

        # What Hermes actually passes: an unrelated run id.
        hermes_run_id = "20260725_143012_ab12cd34"
        self.assertNotIn(hermes_run_id, self.adapter._thread_by_session)

        with unittest.mock.patch.object(
            adapter_module.T3PlatformAdapter,
            "_gateway_session_key",
            staticmethod(lambda: session_id),
        ):
            self.adapter.emit_tool_started(
                hermes_run_id, "web_search", {"query": "hermes"}, "call-1"
            )
            self.adapter.emit_tool_completed(
                hermes_run_id, "web_search", "result", 42, "call-1"
            )
        await asyncio.sleep(0)

        tool_frames = self.connection.messages[frames_before:]
        self.assertEqual(
            [message["type"] for message in tool_frames],
            ["item.started", "item.completed"],
        )
        # Both halves must correlate onto ONE activity item, or T3 renders a
        # started row that never resolves plus an orphan completion.
        self.assertEqual(tool_frames[0]["itemId"], tool_frames[1]["itemId"])
        self.assertEqual(tool_frames[0]["title"], "web_search")
        self.assertEqual(tool_frames[1]["status"], "completed")
        self.assertEqual(tool_frames[0]["threadId"], "thread-tools")
        self.assertEqual(tool_frames[0]["sessionId"], session_id)

    async def test_tool_hooks_fall_back_to_the_sole_active_turn(self):
        """With exactly one active turn there is no ambiguity to resolve."""
        self.adapter._event_loop = asyncio.get_running_loop()
        await self._start_turn("thread-only", "turn-only")
        frames_before = len(self.connection.messages)

        with unittest.mock.patch.object(
            adapter_module.T3PlatformAdapter,
            "_gateway_session_key",
            staticmethod(lambda: ""),
        ):
            self.adapter.emit_tool_started(
                "20260725_143012_ab12cd34", "read_file", {"path": "a.py"}, "call-2"
            )
        await asyncio.sleep(0)

        tool_frames = self.connection.messages[frames_before:]
        self.assertEqual([m["type"] for m in tool_frames], ["item.started"])
        self.assertEqual(tool_frames[0]["threadId"], "thread-only")

    async def test_tool_hooks_drop_when_the_turn_is_ambiguous(self):
        """Two concurrent turns and no routing key: emit nothing.

        Guessing would attach one thread's tool activity to another's
        transcript. Tool activity is decorative, so dropping is correct.
        """
        self.adapter._event_loop = asyncio.get_running_loop()
        await self._start_turn("thread-a", "turn-a")
        await self._start_turn("thread-b", "turn-b")
        frames_before = len(self.connection.messages)

        with unittest.mock.patch.object(
            adapter_module.T3PlatformAdapter,
            "_gateway_session_key",
            staticmethod(lambda: ""),
        ):
            self.adapter.emit_tool_started(
                "20260725_143012_ab12cd34", "read_file", {"path": "a.py"}, "call-3"
            )
            self.adapter.emit_tool_completed(
                "20260725_143012_ab12cd34", "read_file", "ok", 5, "call-3"
            )
        await asyncio.sleep(0)

        self.assertEqual(self.connection.messages[frames_before:], [])

    async def test_tool_hook_session_key_lookup_never_raises(self):
        """An unavailable Hermes session context must degrade, not raise."""
        self.adapter._event_loop = asyncio.get_running_loop()
        await self._start_turn("thread-ctx-a", "turn-ctx-a")
        await self._start_turn("thread-ctx-b", "turn-ctx-b")
        frames_before = len(self.connection.messages)

        def _boom():
            raise RuntimeError("no session context bound")

        with unittest.mock.patch.object(
            adapter_module.T3PlatformAdapter,
            "_gateway_session_key",
            staticmethod(_boom),
        ):
            with self.assertRaises(RuntimeError):
                adapter_module.T3PlatformAdapter._gateway_session_key()

        # The real accessor swallows its own failures rather than propagating.
        with unittest.mock.patch.dict(sys.modules, {"gateway.session_context": None}):
            self.assertEqual(self.adapter._gateway_session_key(), "")
            self.adapter.emit_tool_started(
                "20260725_143012_ab12cd34", "read_file", {"path": "a.py"}, "call-4"
            )
        await asyncio.sleep(0)
        self.assertEqual(self.connection.messages[frames_before:], [])

    async def test_status_line_closes_before_the_assistant_message(self):
        """The status item must complete BEFORE the terminal assistant message.

        T3 folds a settled turn's activity behind the "Worked for …" row, but
        only entries that precede the turn's terminal assistant message.
        Completing the status item afterwards stamped it milliseconds later, so
        it sorted below the answer, escaped the fold, and rendered as a stray
        "Work Log" section under the reply.
        """
        await self._start_turn("thread-order", "turn-order")
        turn = self.adapter._active_turns["thread-order"]
        await self.adapter._emit_generic_activity(turn, "Reading repository")
        await self.adapter.send("thread-order", "The answer")
        order_start = len(self.connection.messages)

        await self.adapter.send("thread-order", "The answer", metadata={"notify": True})

        completions = [
            message
            for message in self.connection.messages[order_start:]
            if message["type"] == "item.completed"
        ]
        self.assertEqual(
            [message["itemType"] for message in completions],
            ["status_text", "assistant_message"],
        )
        types_after = [m["type"] for m in self.connection.messages[order_start:]]
        self.assertEqual(types_after[-2:], ["turn.completed", "connection.status"])

    async def test_cron_tool_hooks_are_excluded_from_the_sole_turn_fallback(self):
        """A cron job's tool calls must never land in an unrelated live turn.

        The hooks are process-global, so a cron job running tools while exactly
        one T3 turn happens to be active would otherwise resolve through the
        sole-active-turn fallback and paint its tool rows into a conversation
        it has nothing to do with. Cron runs are identifiable by the
        `cron_<job>_<timestamp>` session id the scheduler mints
        (`cron/scheduler.py:3017`); their activity belongs to the eventual
        `home.deliver`, not to any turn.
        """
        self.adapter._event_loop = asyncio.get_running_loop()
        await self._start_turn("thread-live", "turn-live")
        frames_before = len(self.connection.messages)
        cron_session = "cron_daily-digest_20260726_090000"

        with unittest.mock.patch.object(
            adapter_module.T3PlatformAdapter,
            "_gateway_session_key",
            staticmethod(lambda: ""),
        ):
            self.adapter.emit_tool_started(
                cron_session, "web_search", {"query": "weather"}, "cron-call-1"
            )
            self.adapter.emit_tool_completed(
                cron_session, "web_search", "sunny", 12, "cron-call-1"
            )
        await asyncio.sleep(0)

        self.assertEqual(self.connection.messages[frames_before:], [])
        # The unrelated turn is untouched and still streaming.
        self.assertIn("thread-live", self.adapter._active_turns)

        # A genuine gateway run id still takes the fallback — the exclusion is
        # scoped to cron, not a blanket removal of the fallback.
        with unittest.mock.patch.object(
            adapter_module.T3PlatformAdapter,
            "_gateway_session_key",
            staticmethod(lambda: ""),
        ):
            self.adapter.emit_tool_started(
                "20260726_090000_ab12cd34", "read_file", {"path": "a.py"}, "call-9"
            )
        await asyncio.sleep(0)
        fallback_frames = self.connection.messages[frames_before:]
        self.assertEqual([m["type"] for m in fallback_frames], ["item.started"])
        self.assertEqual(fallback_frames[0]["threadId"], "thread-live")

    async def test_a_failed_turn_start_leaves_no_phantom_turn_behind(self):
        """A turn that never started must not wedge its thread forever.

        `_active_turns[thread_id]` is registered before `turn.started` goes out,
        so a socket that drops in that window used to leave an entry no
        completion path could ever reach — and the duplicate-turn guard then
        rejected every future `turn.start` on that thread for the life of the
        process. One dropped frame permanently silenced the thread.
        """
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "ensure-wedged",
                "threadId": "thread-wedged",
            }
        )
        session_id = self.adapter._sessions["thread-wedged"]

        original_send = self.connection.send

        async def drop_the_turn_started(message):
            if message.get("type") == "turn.started":
                raise ConnectionError("socket dropped mid-handshake")
            await original_send(message)

        with unittest.mock.patch.object(
            self.connection, "send", drop_the_turn_started
        ):
            await self.adapter._handle_server_frame(
                {
                    "type": "turn.start",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": "start-wedged",
                    "threadId": "thread-wedged",
                    "sessionId": session_id,
                    "turnId": "turn-wedged",
                    "text": "Start",
                }
            )

        # Rolled back, and the failure was reported against its own request.
        self.assertEqual(self.adapter._active_turns, {})
        self.assertEqual(self.connection.messages[-1]["type"], "protocol.error")
        self.assertEqual(self.connection.messages[-1]["requestId"], "start-wedged")

        # The thread is usable again on the very next attempt.
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-recovered",
                "threadId": "thread-wedged",
                "sessionId": session_id,
                "turnId": "turn-recovered",
                "text": "Try again",
            }
        )
        self.assertEqual(
            self.adapter._active_turns["thread-wedged"].turn_id, "turn-recovered"
        )
        self.assertEqual(self.adapter.messages[-1].text, "Try again")


class HomeDeliveryTests(unittest.IsolatedAsyncioTestCase):
    """The proactive `home.deliver` branch and its durable queue."""

    HOME = "home-thread"

    async def asyncSetUp(self):
        self.adapter = adapter_module.T3PlatformAdapter(
            PlatformConfig(
                extra={
                    "url": "wss://t3.example/api/hermes-gateway/ws",
                    "instance_id": "instance",
                    "credential": "credential",
                }
            )
        )
        self.connection = FakeConnection()
        self.adapter._connection = self.connection

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        queue_file = pathlib.Path(self._tmp.name) / "gateway" / "queue.jsonl"
        self.queue = home_module.HomeDeliveryQueue(path=queue_file)
        self.adapter._home_queue = self.queue

        environment = unittest.mock.patch.dict(
            adapter_module.os.environ,
            {home_module.HOME_CHANNEL_ENV: self.HOME},
        )
        environment.start()
        self.addCleanup(environment.stop)

        # No Hermes session context is bound in tests, so the real accessors
        # would fall through to os.environ. Pin them to "no session" — the
        # state a cron run or a lifecycle broadcast is actually in.
        for name in ("_gateway_session_key", "_session_user_id"):
            patch = unittest.mock.patch.object(
                adapter_module.T3PlatformAdapter, name, staticmethod(lambda: "")
            )
            patch.start()
            self.addCleanup(patch.stop)

    async def _start_turn(self, thread_id: str, turn_id: str) -> str:
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": f"ensure-{thread_id}",
                "threadId": thread_id,
            }
        )
        session_id = self.adapter._sessions[thread_id]
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": f"start-{thread_id}",
                "threadId": thread_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "text": "Start",
            }
        )
        return session_id

    async def test_a_proactive_send_to_home_emits_home_deliver(self):
        frames_before = len(self.connection.messages)

        result = await self.adapter.send(
            self.HOME,
            "Cronjob Response: nightly\n(job_id: nightly)\n-------------\n\nDone.",
            metadata={"notify": True, "job_id": "nightly"},
        )

        frames = self.connection.messages[frames_before:]
        self.assertEqual([frame["type"] for frame in frames], ["home.deliver"])
        delivery = frames[0]
        self.assertEqual(
            delivery["protocolVersion"], protocol_module.PROTOCOL_VERSION
        )
        self.assertEqual(delivery["threadId"], self.HOME)
        self.assertEqual(delivery["kind"], "cron")
        self.assertEqual(delivery["label"], "Cron: nightly")
        self.assertTrue(delivery["createdAt"].endswith("Z"))
        self.assertTrue(result.success)
        self.assertEqual(result.message_id, delivery["deliveryId"])

        # No turn was invented, and none was completed.
        self.assertEqual(self.adapter._active_turns, {})

    async def test_a_delivery_never_emits_turn_or_item_frames(self):
        frames_before = len(self.connection.messages)
        await self.adapter.send(self.HOME, "♻️ Gateway online — Hermes is back and ready.")
        emitted = {frame["type"] for frame in self.connection.messages[frames_before:]}
        self.assertEqual(emitted, {"home.deliver"})
        self.assertEqual(self.adapter._active_turns, {})

    async def test_a_notify_stamped_delivery_does_not_complete_the_live_turn(self):
        """THE deadlock regression.

        A cron delivery landing in Home while the user has a live turn there
        arrives notify-stamped (`_mark_notify_metadata`,
        `gateway/platforms/base.py:89`). Under a naive "no active turn →
        deliver" gate it would fall into the active-turn path, stream as that
        turn's assistant content, and its notify stamp would COMPLETE the
        user's turn with the cron output as the answer. The gate is provenance,
        not turn absence: the cron send does not carry the turn's session key,
        so it becomes a `home.deliver` and the turn keeps running.
        """
        session_id = await self._start_turn(self.HOME, "turn-user")
        # The user's turn has already streamed some of its real answer.
        await self.adapter.send(self.HOME, "Working on it")
        frames_before = len(self.connection.messages)

        # A cron delivery fires mid-turn, notify-stamped as every final cron
        # delivery is.
        result = await self.adapter.send(
            self.HOME,
            "Cronjob Response: nightly\n(job_id: nightly)\n-------------\n\nDone.",
            metadata={"notify": True, "job_id": "nightly"},
        )

        frames = self.connection.messages[frames_before:]
        self.assertEqual([frame["type"] for frame in frames], ["home.deliver"])
        self.assertTrue(result.success)

        # The user's turn is untouched: still active, still owning its stream.
        self.assertIn(self.HOME, self.adapter._active_turns)
        turn = self.adapter._active_turns[self.HOME]
        self.assertEqual(turn.turn_id, "turn-user")
        self.assertEqual(turn.visible_text, "Working on it")
        self.assertNotIn(
            "turn.completed", [frame["type"] for frame in self.connection.messages]
        )

        # …and it still completes normally on its own notify, inside its own
        # session context.
        with unittest.mock.patch.object(
            adapter_module.T3PlatformAdapter,
            "_gateway_session_key",
            staticmethod(lambda: session_id),
        ):
            await self.adapter.send(
                self.HOME, "Here is the answer", metadata={"notify": True}
            )
        self.assertNotIn(self.HOME, self.adapter._active_turns)
        self.assertIn(
            "turn.completed", [frame["type"] for frame in self.connection.messages]
        )

    async def test_a_turn_reply_in_home_is_never_rerouted_to_a_delivery(self):
        """Output produced inside the turn's session context is turn content."""
        session_id = await self._start_turn(self.HOME, "turn-user")
        frames_before = len(self.connection.messages)

        with unittest.mock.patch.object(
            adapter_module.T3PlatformAdapter,
            "_gateway_session_key",
            staticmethod(lambda: session_id),
        ):
            await self.adapter.send(self.HOME, "Streaming answer")

        types = [frame["type"] for frame in self.connection.messages[frames_before:]]
        self.assertEqual(types, ["item.started", "content.delta"])
        self.assertNotIn("home.deliver", types)

    async def test_an_unclassifiable_send_during_a_live_home_turn_stays_with_it(self):
        """The conservative half of the gate.

        With a live turn in Home and no positive provenance, the send may well
        be that turn's own output arriving from a context where the session key
        did not resolve. Routing it to `home.deliver` would tear a real answer
        out of the turn; leaving it with the turn is at worst a misplacement
        inside the same thread.
        """
        await self._start_turn(self.HOME, "turn-user")
        frames_before = len(self.connection.messages)

        await self.adapter.send(self.HOME, "Something unclassifiable")

        types = [frame["type"] for frame in self.connection.messages[frames_before:]]
        self.assertEqual(types, ["item.started", "content.delta"])
        self.assertIn(self.HOME, self.adapter._active_turns)

    async def test_a_non_home_thread_without_a_turn_still_errors(self):
        """"Message any thread unprompted" stays out of scope."""
        frames_before = len(self.connection.messages)

        result = await self.adapter.send(
            "some-other-thread",
            "Cronjob Response: nightly\n(job_id: nightly)\n-------------\n\nDone.",
            metadata={"notify": True, "job_id": "nightly"},
        )

        self.assertFalse(result.success)
        self.assertEqual(result.error, "no active T3 turn")
        self.assertEqual(self.connection.messages[frames_before:], [])

    async def test_no_designated_home_means_no_proactive_delivery(self):
        """Before the first `connection.accepted` there is nowhere to deliver."""
        with unittest.mock.patch.dict(
            adapter_module.os.environ, {home_module.HOME_CHANNEL_ENV: ""}
        ):
            result = await self.adapter.send(self.HOME, "Nowhere to go")
        self.assertFalse(result.success)
        self.assertEqual(result.error, "no active T3 turn")

    async def test_edit_message_has_no_proactive_branch(self):
        """A delivery is an atomic document, not a streaming surface."""
        result = await self.adapter.edit_message(
            self.HOME, "some-message", "Revised delivery", finalize=True
        )
        self.assertFalse(result.success)
        self.assertEqual(result.error, "no active T3 turn")
        self.assertEqual(
            [frame["type"] for frame in self.connection.messages], []
        )

    async def test_a_delivery_is_queued_before_it_is_sent_and_purged_on_ack(self):
        result = await self.adapter.send(self.HOME, "Queued then acked")
        delivery_id = result.message_id
        self.assertEqual(
            [entry["deliveryId"] for entry in self.queue.entries()], [delivery_id]
        )

        await self.adapter._handle_server_frame(
            {
                "type": "home.deliver.ack",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "deliveryId": delivery_id,
            }
        )
        self.assertEqual(self.queue.entries(), [])

    async def test_a_delivery_survives_a_dead_socket_and_flushes_on_reconnect(self):
        """Offline delivery: nothing is lost across either side restarting."""

        class DeadConnection:
            connected = False

            async def send(self, message):
                raise ConnectionError("T3 Code gateway is offline")

        self.adapter._connection = DeadConnection()
        with self.assertLogs(adapter_module.logger, level="WARNING"):
            offline = await self.adapter.send(self.HOME, "Sent while offline")
        # Reported successful: it is durably queued and WILL arrive, so a cron
        # job must not log a failure for it.
        self.assertTrue(offline.success)
        self.assertEqual(
            [entry["text"] for entry in self.queue.entries()], ["Sent while offline"]
        )

        # Reconnect: the accepted frame reconciles the designation and flushes.
        self.adapter._connection = self.connection
        await self.adapter._handle_connection_accepted(
            {
                "type": "connection.accepted",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "hello-1",
                "instanceId": "instance",
                "nickname": "Hermes",
                "homeThreadId": self.HOME,
            }
        )

        flushed = self.connection.messages
        self.assertEqual([frame["type"] for frame in flushed], ["home.deliver"])
        self.assertEqual(flushed[0]["text"], "Sent while offline")
        self.assertEqual(flushed[0]["deliveryId"], offline.message_id)
        # Still queued — only the ack purges it.
        self.assertEqual(len(self.queue.entries()), 1)

        await self.adapter._handle_server_frame(
            {
                "type": "home.deliver.ack",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "deliveryId": offline.message_id,
            }
        )
        self.assertEqual(self.queue.entries(), [])

    async def test_a_delivery_that_is_neither_queued_nor_sent_reports_failure(self):
        """Success is a claim about durability, so it needs one leg to hold.

        A queue write that failed used to be ignored: an offline socket then
        produced "delivered" for content held nowhere, and the cron job that
        wrote it logged a success for output that will never appear.
        """

        class DeadConnection:
            connected = False

            async def send(self, message):
                raise ConnectionError("T3 Code gateway is offline")

        self.adapter._connection = DeadConnection()
        with unittest.mock.patch.object(
            self.queue, "append", return_value=False
        ), self.assertLogs(adapter_module.logger, level="WARNING"):
            result = await self.adapter.send(self.HOME, "Held nowhere at all")

        self.assertFalse(result.success)
        self.assertIn("queued", result.error)

    async def test_a_delivery_that_reached_t3_is_honest_success_unqueued(self):
        """T3 has it; the ack will simply find nothing to purge."""
        with unittest.mock.patch.object(self.queue, "append", return_value=False):
            result = await self.adapter.send(self.HOME, "Sent but not queued")

        self.assertTrue(result.success)
        self.assertEqual(
            [frame["type"] for frame in self.connection.messages], ["home.deliver"]
        )
        self.assertEqual(self.queue.entries(), [])

    async def test_flush_restamps_stale_protocol_versions(self):
        """A frame queued under an older plugin must not wedge the reconnect.

        T3's strict-lockstep decoder closes the socket on any frame carrying a
        different protocolVersion, so a v3-era queued delivery would otherwise
        turn one stale outbox entry into a reconnect loop that outlives the
        upgrade. The flush restamps to the current version; the delivery
        fields themselves are version-stable.
        """
        stale = protocol_module.home_deliver(
            thread_id=self.HOME,
            text="Queued before the upgrade",
            kind="cron",
            label="Cron: nightly",
            delivery_id_value="stale-v3-delivery",
        )
        stale["protocolVersion"] = 3
        self.assertTrue(self.queue.append(stale))

        await self.adapter._flush_home_queue()

        flushed = self.connection.messages
        self.assertEqual(len(flushed), 1)
        self.assertEqual(flushed[0]["protocolVersion"], protocol_module.PROTOCOL_VERSION)
        self.assertEqual(flushed[0]["text"], "Queued before the upgrade")
        # The queued copy is untouched — restamping happens on the wire only,
        # and the entry still purges by deliveryId on ack.
        self.assertEqual(self.queue.entries()[0]["protocolVersion"], 3)

    async def test_the_queue_flushes_in_fifo_order(self):
        class DeadConnection:
            connected = False

            async def send(self, message):
                raise ConnectionError("T3 Code gateway is offline")

        self.adapter._connection = DeadConnection()
        with self.assertLogs(adapter_module.logger, level="WARNING"):
            for text in ("first", "second", "third"):
                await self.adapter.send(self.HOME, text)

        self.adapter._connection = self.connection
        await self.adapter._flush_home_queue()

        self.assertEqual(
            [frame["text"] for frame in self.connection.messages],
            ["first", "second", "third"],
        )

    async def test_connection_accepted_reconciles_the_home_designation(self):
        """T3 owns the designation; a differing local value is overwritten."""
        with unittest.mock.patch.dict(
            adapter_module.os.environ,
            {home_module.HOME_CHANNEL_ENV: "stale-hand-edited-thread"},
        ), unittest.mock.patch.object(
            adapter_module, "save_home_thread_id"
        ) as save:
            await self.adapter._handle_connection_accepted(
                {
                    "type": "connection.accepted",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": "hello-1",
                    "instanceId": "instance",
                    "nickname": "Hermes",
                    "homeThreadId": "authoritative-thread",
                }
            )
        save.assert_called_once_with("authoritative-thread")

    async def test_an_accepted_frame_without_a_home_thread_changes_nothing(self):
        """Resolving the home thread must never fail a handshake."""
        with unittest.mock.patch.object(
            adapter_module, "save_home_thread_id"
        ) as save:
            await self.adapter._handle_connection_accepted(
                {
                    "type": "connection.accepted",
                    "protocolVersion": protocol_module.PROTOCOL_VERSION,
                    "requestId": "hello-1",
                    "instanceId": "instance",
                    "nickname": "Hermes",
                }
            )
        save.assert_not_called()
        self.assertEqual(adapter_module.home_thread_id(), self.HOME)

    async def test_a_nameless_ack_is_a_correlated_protocol_error(self):
        await self.adapter._handle_server_frame(
            {
                "type": "home.deliver.ack",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "ack-1",
            }
        )
        reply = self.connection.messages[-1]
        self.assertEqual(reply["type"], "protocol.error")
        self.assertEqual(reply["code"], "unsupported-message")


class InboundAttachmentTests(unittest.IsolatedAsyncioTestCase):
    """v4+ turn attachments: base64 on the frame → temp files → media_urls."""

    async def asyncSetUp(self):
        self.adapter = adapter_module.T3PlatformAdapter(
            PlatformConfig(
                extra={
                    "url": "wss://t3.example/api/hermes-gateway/ws",
                    "instance_id": "instance",
                    "credential": "credential",
                }
            )
        )
        self.connection = FakeConnection()
        self.adapter._connection = self.connection

    async def _ensure(self, thread_id: str) -> str:
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": f"ensure-{thread_id}",
                "threadId": thread_id,
            }
        )
        return self.adapter._sessions[thread_id]

    async def test_turn_attachments_land_as_local_files_on_the_message_event(self):
        import base64

        session_id = await self._ensure("thread-attach")
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-attach",
                "threadId": "thread-attach",
                "sessionId": session_id,
                "turnId": "turn-attach",
                "text": "Describe this image",
                "attachments": [
                    {
                        "name": "photo.png",
                        "mimeType": "image/png",
                        "sizeBytes": 9,
                        "data": base64.b64encode(b"PNG bytes").decode("ascii"),
                    },
                    {
                        "name": "notes.txt",
                        "mimeType": "text/plain",
                        "sizeBytes": 5,
                        "data": base64.b64encode(b"hello").decode("ascii"),
                    },
                ],
            }
        )

        event = self.adapter.messages[-1]
        self.assertEqual(event.text, "Describe this image")
        # Aligned pairs, exactly the shape Hermes' enrichment pipeline reads.
        self.assertEqual(event.media_types, ["image/png", "text/plain"])
        self.assertEqual(len(event.media_urls), 2)
        for path, payload in zip(event.media_urls, [b"PNG bytes", b"hello"]):
            self.addCleanup(
                lambda p=path: pathlib.Path(p).unlink(missing_ok=True)
            )
            self.assertEqual(pathlib.Path(path).read_bytes(), payload)
            # Secure perms: owner-only file in an owner-only directory.
            self.assertEqual(pathlib.Path(path).stat().st_mode & 0o777, 0o600)
            self.assertEqual(
                pathlib.Path(path).parent.stat().st_mode & 0o777, 0o700
            )
        # The extension survives — Hermes routes files by suffix in several
        # places (audio-vs-document, the text-document allowlist).
        self.assertTrue(event.media_urls[0].endswith(".png"))
        self.assertTrue(event.media_urls[1].endswith(".txt"))

    async def test_a_hostile_attachment_name_cannot_escape_the_temp_directory(self):
        import base64

        session_id = await self._ensure("thread-hostile")
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-hostile",
                "threadId": "thread-hostile",
                "sessionId": session_id,
                "turnId": "turn-hostile",
                "text": "Look at this",
                "attachments": [
                    {
                        "name": "../../etc/passwd",
                        "mimeType": "text/plain",
                        "sizeBytes": 4,
                        "data": base64.b64encode(b"evil").decode("ascii"),
                    }
                ],
            }
        )
        event = self.adapter.messages[-1]
        path = pathlib.Path(event.media_urls[0])
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        self.assertTrue(
            path.parent.name.startswith("hermes-t3-attachments-"),
            path,
        )
        self.assertNotIn("..", path.name)

    async def test_a_turn_without_attachments_carries_no_media(self):
        session_id = await self._ensure("thread-plain")
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-plain",
                "threadId": "thread-plain",
                "sessionId": session_id,
                "turnId": "turn-plain",
                "text": "Just text",
            }
        )
        event = self.adapter.messages[-1]
        self.assertEqual(event.media_urls, [])
        self.assertEqual(event.media_types, [])

    async def test_a_malformed_attachment_errors_before_any_turn_starts(self):
        session_id = await self._ensure("thread-bad-attach")
        frames_before = len(self.connection.messages)
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-bad",
                "threadId": "thread-bad-attach",
                "sessionId": session_id,
                "turnId": "turn-bad",
                "text": "With a broken file",
                "attachments": [{"name": "x.bin", "data": "!!! not base64 !!!"}],
            }
        )
        frames = self.connection.messages[frames_before:]
        self.assertEqual([frame["type"] for frame in frames], ["protocol.error"])
        self.assertEqual(frames[0]["requestId"], "start-bad")
        # No half-started turn to clean up, and nothing reached Hermes.
        self.assertNotIn("thread-bad-attach", self.adapter._active_turns)
        self.assertEqual(
            [event.text for event in self.adapter.messages
             if getattr(event, "message_id", "") == "start-bad"],
            [],
        )

    async def test_steer_attachments_ride_the_injected_text_as_path_notes(self):
        import base64

        session_id = await self._ensure("thread-steer-attach")
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "start-steer-attach",
                "threadId": "thread-steer-attach",
                "sessionId": session_id,
                "turnId": "turn-steer-attach",
                "text": "Start",
            }
        )

        async def accept_steer(_event):
            return "⏩ Steer queued — arrives after the next tool call"

        self.adapter._message_handler = accept_steer
        await self.adapter._handle_server_frame(
            {
                "type": "turn.steer",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "steer-attach",
                "threadId": "thread-steer-attach",
                "sessionId": session_id,
                "turnId": "turn-steer-attach",
                "text": "Use this file",
                "attachments": [
                    {
                        "name": "data.csv",
                        "mimeType": "text/csv",
                        "sizeBytes": 3,
                        "data": base64.b64encode(b"a,b").decode("ascii"),
                    }
                ],
            }
        )
        steer_event = self.adapter.messages[-1]
        # Hermes' /steer handler injects only text between tool iterations
        # (`gateway/run.py:11254`), so the file rides the command as a path
        # note the mid-turn agent can open with its tools.
        self.assertTrue(steer_event.text.startswith("/steer Use this file\n"))
        self.assertIn("[The user attached a file (text/csv): ", steer_event.text)
        path = steer_event.text.rsplit(": ", 1)[1].rstrip("]")
        self.addCleanup(lambda: pathlib.Path(path).unlink(missing_ok=True))
        self.assertEqual(pathlib.Path(path).read_bytes(), b"a,b")


class MediaDeliveryTests(unittest.IsolatedAsyncioTestCase):
    """Outbound `media.deliver`: turn scoping plus the durable ack lifecycle."""

    HOME = "home-thread"

    async def asyncSetUp(self):
        self.adapter = adapter_module.T3PlatformAdapter(
            PlatformConfig(
                extra={
                    "url": "wss://t3.example/api/hermes-gateway/ws",
                    "instance_id": "instance",
                    "credential": "credential",
                }
            )
        )
        self.connection = FakeConnection()
        self.adapter._connection = self.connection

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        queue_file = pathlib.Path(self._tmp.name) / "gateway" / "queue.jsonl"
        self.queue = home_module.HomeDeliveryQueue(path=queue_file)
        self.adapter._home_queue = self.queue

        self.chart = pathlib.Path(self._tmp.name) / "chart.png"
        self.chart.write_bytes(b"\x89PNG fake bytes")

        environment = unittest.mock.patch.dict(
            adapter_module.os.environ,
            {home_module.HOME_CHANNEL_ENV: self.HOME},
        )
        environment.start()
        self.addCleanup(environment.stop)

        for name in ("_gateway_session_key", "_session_user_id"):
            patch = unittest.mock.patch.object(
                adapter_module.T3PlatformAdapter, name, staticmethod(lambda: "")
            )
            patch.start()
            self.addCleanup(patch.stop)

    async def _start_turn(self, thread_id: str, turn_id: str) -> str:
        await self.adapter._handle_server_frame(
            {
                "type": "session.ensure",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": f"ensure-{thread_id}",
                "threadId": thread_id,
            }
        )
        session_id = self.adapter._sessions[thread_id]
        await self.adapter._handle_server_frame(
            {
                "type": "turn.start",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": f"start-{thread_id}",
                "threadId": thread_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "text": "Start",
            }
        )
        return session_id

    async def test_turn_media_is_delivered_turn_scoped(self):
        await self._start_turn("thread-media", "turn-media")
        frames_before = len(self.connection.messages)

        result = await self.adapter.send_image_file(
            "thread-media", str(self.chart), caption="A chart"
        )

        frames = self.connection.messages[frames_before:]
        self.assertEqual([frame["type"] for frame in frames], ["media.deliver"])
        delivery = frames[0]
        self.assertEqual(
            delivery["protocolVersion"], protocol_module.PROTOCOL_VERSION
        )
        self.assertEqual(delivery["threadId"], "thread-media")
        self.assertEqual(delivery["turnId"], "turn-media")
        self.assertEqual(delivery["name"], "chart.png")
        self.assertEqual(delivery["mimeType"], "image/png")
        self.assertEqual(delivery["caption"], "A chart")
        self.assertTrue(result.success)
        self.assertEqual(result.message_id, delivery["deliveryId"])
        # Media never touches the turn machinery: the turn is still live and
        # no turn/item frame was emitted for the file.
        self.assertIn("thread-media", self.adapter._active_turns)

    async def test_reply_media_arriving_just_after_completion_keeps_its_turn(self):
        """The base adapter sends a reply's text BEFORE its media files
        (`gateway/platforms/base.py:5326` then `:5383+`), and the notify-marked
        text completes the T3 turn — so a reply's chart routinely arrives
        moments after its turn closed and must still land turn-scoped."""
        session_id = await self._start_turn("thread-late-media", "turn-late")
        with unittest.mock.patch.object(
            adapter_module.T3PlatformAdapter,
            "_gateway_session_key",
            staticmethod(lambda: session_id),
        ):
            await self.adapter.send(
                "thread-late-media", "Here is the chart", metadata={"notify": True}
            )
            self.assertNotIn("thread-late-media", self.adapter._active_turns)
            frames_before = len(self.connection.messages)

            result = await self.adapter.send_image_file(
                "thread-late-media", str(self.chart)
            )

        self.assertTrue(result.success)
        delivery = self.connection.messages[frames_before:][0]
        self.assertEqual(delivery["type"], "media.deliver")
        self.assertEqual(delivery["turnId"], "turn-late")

    async def test_live_repro_reply_media_lands_with_no_session_key_bound(self):
        """The 2026-07-27 18:47:06 gateway.log repro, end to end.

        An ordinary (non-home) thread asks for an image. Upstream's delivery
        pipeline sends the reply's notify-marked TEXT — completing the T3 turn
        through the real completion path — and 36ms later dispatches the file.

        The session context is modelled as it ACTUALLY is at that moment:
        UNAVAILABLE. `HERMES_SESSION_KEY` is bound inside
        `_handle_message_with_agent` and cleared in its own `finally`
        (`gateway/run.py:12972` → `:14626`), while this whole delivery block
        runs one frame further out in
        `BasePlatformAdapter._process_message_background`, after the handler
        returned — and `clear_session_vars` sets `""` rather than resetting, so
        the `os.environ` fallback is suppressed too. Every send here reads `""`.

        That is why the file was dropped with "no active T3 turn": the text
        path never consults the key when a live turn exists, but the media path
        required it to match. The class default `_gateway_session_key` stub
        (`lambda: ""`) is exactly this state — no per-test patch.
        """
        thread = "3667b0a1-c1db-4216-8e72-2f62a3ff87e2"
        await self._start_turn(thread, "turn-live-repro")

        # The reply's final text. notify=True is what upstream stamps via
        # `_mark_notify_metadata`, and it completes the turn for real.
        text_result = await self.adapter.send(
            thread,
            "Here's the image you asked for.",
            metadata={"thread_id": thread, "notify": True},
        )
        self.assertTrue(text_result.success)
        self.assertNotIn(thread, self.adapter._active_turns)
        completed = [
            frame
            for frame in self.connection.messages
            if frame["type"] == "turn.completed"
        ]
        self.assertEqual([frame["turnId"] for frame in completed], ["turn-live-repro"])
        frames_before = len(self.connection.messages)

        # ~36ms later: the same reply's image, same metadata dict.
        result = await self.adapter.send_image_file(
            thread,
            str(self.chart),
            caption=None,
            metadata={"thread_id": thread, "notify": True},
        )

        self.assertTrue(result.success)
        frames = self.connection.messages[frames_before:]
        self.assertEqual([frame["type"] for frame in frames], ["media.deliver"])
        delivery = frames[0]
        # Scoped to its own turn, in its own thread — not exiled to Home.
        self.assertEqual(delivery["threadId"], thread)
        self.assertEqual(delivery["turnId"], "turn-live-repro")
        self.assertEqual(delivery["name"], "chart.png")
        # The completed turn is not resurrected by claiming its media.
        self.assertNotIn(thread, self.adapter._active_turns)

    async def test_an_image_only_reply_completes_its_turn(self):
        """Live repro 2026-07-27 21:26: "send it one more time" → image, no text.

        Upstream notify-marks every send of a reply's final delivery batch —
        text AND media (`_mark_notify_metadata`, base.py:5220) — but a reply
        that is only an image produces no text send, so the media send is the
        only carrier of the completion signal. Without honoring it, the turn
        sat "Working" until the two-minute liveness timeout.
        """
        thread = "thread-image-only-reply"
        await self._start_turn(thread, "turn-image-only")
        frames_before = len(self.connection.messages)

        result = await self.adapter.send_image_file(
            thread,
            str(self.chart),
            caption=None,
            metadata={"thread_id": thread, "notify": True},
        )

        self.assertTrue(result.success)
        frames = self.connection.messages[frames_before:]
        # `_complete_turn` also republishes connection.status; the contract
        # here is the ORDER media -> completed, not the exact frame set.
        types = [frame["type"] for frame in frames]
        self.assertEqual(types[:2], ["media.deliver", "turn.completed"])
        self.assertEqual(frames[0]["turnId"], "turn-image-only")
        self.assertEqual(frames[1]["turnId"], "turn-image-only")
        self.assertNotIn(thread, self.adapter._active_turns)

    async def test_trailing_media_does_not_recomplete_a_closed_turn(self):
        """The text-then-media ordering must emit exactly one turn.completed.

        The text completes the turn; the file's own notify mark must not
        re-complete the `_recent_turns` entry it scopes to — T3 already
        folded the turn, and a second terminal frame names a turn its
        conflict gate would reject.
        """
        thread = "thread-text-then-media"
        await self._start_turn(thread, "turn-text-media")
        await self.adapter.send(
            thread, "Here it is.", metadata={"thread_id": thread, "notify": True}
        )
        frames_before = len(self.connection.messages)

        result = await self.adapter.send_image_file(
            thread,
            str(self.chart),
            caption=None,
            metadata={"thread_id": thread, "notify": True},
        )

        self.assertTrue(result.success)
        frames = self.connection.messages[frames_before:]
        self.assertEqual([frame["type"] for frame in frames], ["media.deliver"])

    async def test_media_long_after_a_turn_closed_does_not_claim_it(self):
        """Recency is what bounds the reach-back, so an old turn must not claim.

        Without the window, `_recent_turns` would keep a thread's last turn
        claimable forever and an unrelated later delivery would be sequenced
        into an answer the user finished reading long ago.
        """
        thread = "thread-stale-reachback"
        await self._start_turn(thread, "turn-stale")
        await self.adapter.send(thread, "Done.", metadata={"notify": True})
        self.assertNotIn(thread, self.adapter._active_turns)

        stale = self.adapter._recent_turns[thread]
        stale.completed_at -= adapter_module._RECENT_TURN_MEDIA_WINDOW_SECONDS + 1
        frames_before = len(self.connection.messages)

        with self.assertLogs(adapter_module.logger, level="INFO"):
            result = await self.adapter.send_document(thread, str(self.chart))

        self.assertTrue(result.success)
        delivery = self.connection.messages[frames_before:][0]
        self.assertNotIn("turnId", delivery)
        self.assertEqual(delivery["threadId"], self.HOME)

    async def test_a_cron_delivery_never_claims_a_just_closed_turn(self):
        """Provenance still overrides recency inside the window.

        A positively-classified proactive send — cron here — is refused the
        completed turn even microseconds after it closed, and takes the
        turnless home route with its badge intact. This is the guard that
        keeps the recency window from re-opening the defect class the
        session-key gate was built for.
        """
        thread = "thread-cron-collision"
        await self._start_turn(thread, "turn-cron-collision")
        await self.adapter.send(thread, "All set.", metadata={"notify": True})
        self.assertIsNotNone(self.adapter._recent_turns[thread].completed_at)
        frames_before = len(self.connection.messages)

        with self.assertLogs(adapter_module.logger, level="INFO"):
            result = await self.adapter.send_document(
                thread,
                str(self.chart),
                caption="Cronjob Response: nightly\n-------------\n\nChart attached.",
            )

        self.assertTrue(result.success)
        delivery = self.connection.messages[frames_before:][0]
        self.assertNotIn("turnId", delivery)
        self.assertEqual(delivery["threadId"], self.HOME)
        self.assertEqual(delivery["kind"], "cron")
        self.assertEqual(delivery["label"], "Cron: nightly")

    async def test_a_live_turn_still_outranks_a_completed_one(self):
        """The user asked again; the new turn owns the thread, not the old one."""
        thread = "thread-relay"
        await self._start_turn(thread, "turn-first")
        await self.adapter.send(thread, "First answer.", metadata={"notify": True})
        await self._start_turn(thread, "turn-second")
        frames_before = len(self.connection.messages)

        result = await self.adapter.send_image_file(thread, str(self.chart))

        self.assertTrue(result.success)
        delivery = self.connection.messages[frames_before:][0]
        self.assertEqual(delivery["turnId"], "turn-second")

    async def test_proactive_media_to_home_is_turnless_with_provenance(self):
        frames_before = len(self.connection.messages)

        result = await self.adapter.send_document(
            self.HOME,
            str(self.chart),
            caption=(
                "Cronjob Response: nightly\n(job_id: nightly)\n"
                "-------------\n\nDone."
            ),
        )

        frames = self.connection.messages[frames_before:]
        self.assertEqual([frame["type"] for frame in frames], ["media.deliver"])
        delivery = frames[0]
        self.assertNotIn("turnId", delivery)
        self.assertEqual(delivery["kind"], "cron")
        self.assertEqual(delivery["label"], "Cron: nightly")
        self.assertTrue(result.success)
        self.assertEqual(self.adapter._active_turns, {})

    async def test_unscopeable_media_falls_back_to_home_instead_of_dropping(self):
        """"Send media to any thread unprompted" still lands — in Home.

        The thread route stays out of scope: the frame goes out turnless, so
        T3 re-resolves the home thread server-side and can write nowhere else.
        But the file is NOT dropped. Upstream's only response to a failed
        media send is a log line, so returning an error silently loses an
        artifact Hermes already spent a generation call producing.
        """
        with self.assertLogs(adapter_module.logger, level="INFO"):
            result = await self.adapter.send_document(
                "some-other-thread", str(self.chart)
            )

        self.assertTrue(result.success)
        frames = self.connection.messages
        self.assertEqual([frame["type"] for frame in frames], ["media.deliver"])
        delivery = frames[0]
        # Home-addressed and turnless: it renders as a badged notification,
        # never as a reply inside the thread that could not take it.
        self.assertEqual(delivery["threadId"], self.HOME)
        self.assertNotIn("turnId", delivery)
        self.assertEqual(delivery["label"], "Hermes")
        self.assertEqual(
            [entry["deliveryId"] for entry in self.queue.entries()],
            [result.message_id],
        )

    async def test_media_with_no_home_designated_still_errors(self):
        """With nowhere to fall back to, the original error stands."""
        with unittest.mock.patch.dict(
            adapter_module.os.environ, {home_module.HOME_CHANNEL_ENV: ""}
        ):
            result = await self.adapter.send_document(
                "some-other-thread", str(self.chart)
            )
        self.assertFalse(result.success)
        self.assertEqual(result.error, "no active T3 turn")
        self.assertEqual(self.connection.messages, [])
        self.assertEqual(self.queue.entries(), [])

    async def test_media_is_queued_before_it_is_sent_and_purged_only_on_ack(self):
        result = await self.adapter.send_video(self.HOME, str(self.chart))
        delivery_id = result.message_id
        self.assertEqual(
            [entry["deliveryId"] for entry in self.queue.entries()], [delivery_id]
        )

        # A home.deliver.ack for some OTHER delivery purges nothing.
        await self.adapter._handle_server_frame(
            {
                "type": "media.deliver.ack",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "deliveryId": "unrelated",
            }
        )
        self.assertEqual(len(self.queue.entries()), 1)

        await self.adapter._handle_server_frame(
            {
                "type": "media.deliver.ack",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "deliveryId": delivery_id,
            }
        )
        self.assertEqual(self.queue.entries(), [])

    async def test_queued_media_survives_a_dead_socket_and_flushes_on_reconnect(self):
        class DeadConnection:
            connected = False

            async def send(self, message):
                raise ConnectionError("T3 Code gateway is offline")

        self.adapter._connection = DeadConnection()
        with self.assertLogs(adapter_module.logger, level="WARNING"):
            offline = await self.adapter.send_document(self.HOME, str(self.chart))
        # Reported successful: durably queued, WILL arrive.
        self.assertTrue(offline.success)
        self.assertEqual(len(self.queue.entries()), 1)

        self.adapter._connection = self.connection
        await self.adapter._handle_connection_accepted(
            {
                "type": "connection.accepted",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "requestId": "hello-1",
                "instanceId": "instance",
                "nickname": "Hermes",
                "homeThreadId": self.HOME,
            }
        )
        flushed = self.connection.messages
        self.assertEqual([frame["type"] for frame in flushed], ["media.deliver"])
        self.assertEqual(flushed[0]["deliveryId"], offline.message_id)
        self.assertEqual(flushed[0]["name"], "chart.png")
        # Still queued — only the ack purges it.
        self.assertEqual(len(self.queue.entries()), 1)

        await self.adapter._handle_server_frame(
            {
                "type": "media.deliver.ack",
                "protocolVersion": protocol_module.PROTOCOL_VERSION,
                "deliveryId": offline.message_id,
            }
        )
        self.assertEqual(self.queue.entries(), [])

    async def test_an_unreadable_file_fails_the_send_and_queues_nothing(self):
        """A frame T3 would reject forever must never enter the outbox."""
        await self._start_turn("thread-bad-file", "turn-bad-file")
        with self.assertLogs(adapter_module.logger, level="WARNING"):
            result = await self.adapter.send_image_file(
                "thread-bad-file", str(pathlib.Path(self._tmp.name) / "gone.png")
            )
        self.assertFalse(result.success)
        self.assertEqual(self.queue.entries(), [])
        self.assertNotIn(
            "media.deliver",
            [frame["type"] for frame in self.connection.messages],
        )

    async def test_media_that_is_neither_queued_nor_sent_reports_failure(self):
        """An unpersisted delivery must not be reported as durable.

        Success here used to be unconditional on the queue write, so a full
        disk plus a dead socket produced "delivered" for a file that exists
        nowhere — and, on a notify-marked send, completed the turn on it. The
        bytes are the only copy: Hermes' temp file is reaped and nothing can
        replay a frame that was never written.
        """

        class DeadConnection:
            connected = False

            async def send(self, message):
                raise ConnectionError("T3 Code gateway is offline")

        thread = "thread-nowhere-to-go"
        await self._start_turn(thread, "turn-nowhere")
        self.adapter._connection = DeadConnection()

        with unittest.mock.patch.object(
            self.queue, "append", return_value=False
        ), self.assertLogs(adapter_module.logger, level="WARNING"):
            result = await self.adapter.send_image_file(
                thread,
                str(self.chart),
                metadata={"thread_id": thread, "notify": True},
            )

        self.assertFalse(result.success)
        self.assertIn("queued", result.error)
        # The turn is NOT completed on media that went nowhere.
        self.assertIn(thread, self.adapter._active_turns)

    async def test_media_that_reached_t3_is_honest_success_without_the_queue(self):
        """The other branch: the live send held, so T3 has the file.

        The queue's only remaining job would be a replay T3 does not need, and
        the ack simply finds nothing to purge.
        """
        thread = "thread-sent-not-queued"
        await self._start_turn(thread, "turn-sent-not-queued")
        frames_before = len(self.connection.messages)

        with unittest.mock.patch.object(self.queue, "append", return_value=False):
            result = await self.adapter.send_image_file(thread, str(self.chart))

        self.assertTrue(result.success)
        self.assertEqual(
            [frame["type"] for frame in self.connection.messages[frames_before:]],
            ["media.deliver"],
        )

    async def test_audio_rides_the_same_media_frame_instead_of_the_fallback(self):
        """T3 renders audio as a download card — still strictly better than
        the base class's "couldn't deliver the audio attachment" notice."""
        audio = pathlib.Path(self._tmp.name) / "reply.mp3"
        audio.write_bytes(b"ID3 fake audio")
        await self._start_turn("thread-audio", "turn-audio")
        frames_before = len(self.connection.messages)

        result = await self.adapter.send_voice("thread-audio", str(audio))

        self.assertTrue(result.success)
        delivery = self.connection.messages[frames_before:][0]
        self.assertEqual(delivery["type"], "media.deliver")
        self.assertEqual(delivery["mimeType"], "audio/mpeg")


class EnvEnablementTests(unittest.TestCase):
    """`home_channel` is the magic key that makes `get_home_channel` resolve."""

    ENROLLED = {
        "HERMES_T3_GATEWAY_URL": "wss://t3.example/api/hermes-gateway/ws",
        "HERMES_T3_GATEWAY_INSTANCE_ID": "instance",
        "HERMES_T3_GATEWAY_CREDENTIAL": "credential",
    }

    def test_a_designated_home_seeds_the_magic_home_channel_key(self):
        with unittest.mock.patch.dict(
            adapter_module.os.environ,
            {**self.ENROLLED, home_module.HOME_CHANNEL_ENV: "home-thread"},
        ):
            seed = adapter_module.env_enablement()
        # Core pops this key and promotes it to a real HomeChannel dataclass
        # (gateway/config.py:2648-2660), reading only chat_id/name/thread_id.
        # T3 threads are the addressing unit, so chat_id IS the thread id and
        # thread_id stays unset.
        self.assertEqual(
            seed["home_channel"], {"chat_id": "home-thread", "name": "Home"}
        )

    def test_no_designation_yet_seeds_no_home_channel(self):
        with unittest.mock.patch.dict(
            adapter_module.os.environ,
            {**self.ENROLLED, home_module.HOME_CHANNEL_ENV: ""},
        ):
            seed = adapter_module.env_enablement()
        # The pre-designation window — first connect, before any
        # `connection.accepted`. This is exactly why the `/sethome` nudge
        # suppression is still needed.
        self.assertNotIn("home_channel", seed)
        self.assertEqual(seed["instance_id"], "instance")

    def test_an_unenrolled_hermes_seeds_nothing_at_all(self):
        with unittest.mock.patch.dict(
            adapter_module.os.environ,
            {**self.ENROLLED, "HERMES_T3_GATEWAY_CREDENTIAL": ""},
        ):
            self.assertIsNone(adapter_module.env_enablement())


if __name__ == "__main__":
    unittest.main()
