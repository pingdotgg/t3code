"""Hermes plugin entry point for the T3 Code repository."""

from .integrations.hermes_plugin import register

__all__ = ["register"]
