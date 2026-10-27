"""The canonical human hash and public address truncation (SPEC 3.5)."""

from __future__ import annotations

import hashlib


def hash_human_id(human_id: str) -> str:
    """sha256 of the domain-separated humanId, hex-encoded.

    CANONICAL, program-wide, frozen for v1: every surface that displays
    a human hash displays this hash for a given human. Changing the
    prefix, algorithm, input form, or encoding is a breaking
    program-level change (SPEC 3.5).
    """
    return hashlib.sha256(f"w0-human-v1:{human_id}".encode("utf-8")).hexdigest()


def truncate_address(address: str) -> str:
    """'0x7d7D…6097f' form: first 6 characters, ellipsis, last 5."""
    return f"{address[:6]}…{address[-5:]}"
