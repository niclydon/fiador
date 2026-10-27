"""The package's process-local reference nonce store."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from fiador_verify.nonce_store import InMemoryNonceStore

from conftest import fmt_z


def test_concurrent_claims_have_one_winner(fixed_now):
    store = InMemoryNonceStore(now=lambda: fixed_now)
    expiry = fmt_z(fixed_now + timedelta(minutes=1))
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(store.claim, "nonce", "0xAbC", expiry)
        second = pool.submit(store.claim, "nonce", "0xabc", expiry)
        results = [first.result(), second.result()]
    assert sorted(results) == ["claimed", "replay"]
    assert store.has("nonce", "0xABC") is True


def test_entry_lapses_at_expiry(fixed_now):
    clock = [fixed_now]
    store = InMemoryNonceStore(now=lambda: clock[0])
    expiry = fmt_z(fixed_now + timedelta(minutes=1))
    assert store.claim("nonce", "0xAbC", expiry) == "claimed"
    assert store.has("nonce", "0xABC") is True
    clock[0] = fixed_now + timedelta(minutes=1)
    assert store.has("nonce", "0xabc") is False
    assert store.claim("nonce", "0xabc", expiry) == "expired"
