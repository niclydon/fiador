"""EVM address validation and EIP-55 checksumming.

Mirrors viem's ``isAddress`` (strict by default) and ``getAddress`` as
used by the TypeScript core: a 0x-prefixed 40-hex-digit string is an
address; all-lowercase and all-uppercase forms are accepted as-is, and
a mixed-case form must carry a valid EIP-55 checksum.
"""

from __future__ import annotations

import re
from typing import Any

from eth_utils import to_checksum_address

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def is_address(value: Any) -> bool:
    if not isinstance(value, str) or not _ADDRESS_RE.match(value):
        return False
    body = value[2:]
    if body.lower() == body or body.upper() == body:
        return True
    try:
        return to_checksum_address(value) == value
    except Exception:
        return False


def checksum_address(value: Any) -> str:
    """EIP-55 checksummed form. Raises ValueError for malformed input,
    including a mixed-case input whose checksum does not verify (the
    viem ``getAddress`` behaviour the TS core relies on)."""
    if not isinstance(value, str) or not _ADDRESS_RE.match(value):
        raise ValueError(f"malformed address: {value!r}")
    checksummed = to_checksum_address(value)
    body = value[2:]
    if body.lower() != body and body.upper() != body and checksummed != value:
        raise ValueError(f"bad address checksum: {value!r}")
    return checksummed
