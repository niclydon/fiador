"""Live tests against the real AgentBook contract (SPEC 7.4).

Excluded from the default run: they execute only with
LIVE_AGENTBOOK=1 and assert status only. Addresses come from the
environment; no humanId or hash of a real wallet is printed or
asserted beyond the status itself.
"""

from __future__ import annotations

import os

import pytest

from fiador_verify import create_verifier

pytestmark = pytest.mark.skipif(
    os.environ.get("LIVE_AGENTBOOK") != "1",
    reason="live AgentBook tests are gated behind LIVE_AGENTBOOK=1",
)


def test_live_registered_address_verifies():
    address = os.environ["LIVE_REGISTERED_ADDRESS"]
    result = create_verifier().verify_address(address)
    assert result.status == "verified"
    assert result.failures == []


def test_live_unregistered_address_is_unregistered():
    address = os.environ["LIVE_UNREGISTERED_ADDRESS"]
    result = create_verifier().verify_address(address)
    assert result.status == "unregistered"
    assert result.failures == ["not_registered"]
