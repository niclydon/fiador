"""Process-local reference for the verifier's atomic nonce claim contract."""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Callable

from .canonical import parse_iso8601_z_ms
from .types import NonceClaimResult


class InMemoryNonceStore:
    """A single-process reference store; production needs durable shared storage."""

    def __init__(self, now: Callable[[], datetime] | None = None):
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._claims: dict[tuple[str, str], int] = {}
        self._lock = threading.Lock()

    def _now_ms(self) -> int:
        value = self._now()
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return int(value.timestamp() * 1000)

    @staticmethod
    def _key(nonce: str, wallet: str) -> tuple[str, str]:
        return wallet.lower(), nonce

    def has(self, nonce: str, wallet: str) -> bool:
        key = self._key(nonce, wallet)
        with self._lock:
            expiry = self._claims.get(key)
            if expiry is None:
                return False
            if expiry <= self._now_ms():
                del self._claims[key]
                return False
            return True

    def claim(self, nonce: str, wallet: str, expires_at: str) -> NonceClaimResult:
        expiry = parse_iso8601_z_ms(expires_at)
        key = self._key(nonce, wallet)
        with self._lock:
            now_ms = self._now_ms()
            if expiry <= now_ms:
                return "expired"
            existing = self._claims.get(key)
            if existing is not None and existing > now_ms:
                return "replay"
            self._claims[key] = expiry
            return "claimed"
