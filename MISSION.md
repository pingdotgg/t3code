# Mission

The toolboxmd fork of T3 Code is the user's working surface. It stays a thin,
rebasable layer on upstream `pingdotgg/t3code`: features live in new files and
packages, upstream files carry the smallest possible edits, and generic
extension points are offered upstream so the patch set shrinks over time.

On T3's core the fork adds what the user's tools need instead of rebuilding
harness plumbing: Model Router jobs run as T3 threads, visible and reachable
from the thread that started them; OpenBot becomes a mode switched in the UI,
bringing Bots, Channels and the Computer; further capabilities such as VMs
follow. AgentsMD plugins extend the fork rather than competing with it.
