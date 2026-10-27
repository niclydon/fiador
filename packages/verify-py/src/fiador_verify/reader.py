"""AgentBook readers: the live contract reader and a static test reader.

The live reader reads the AgentBook contract directly over raw
JSON-RPC. It deliberately does NOT wrap the AgentKit SDK: in
@worldcoin/agentkit(-core) 0.2.1, ``lookupHuman`` wraps its contract
read in ``catch { return null }``, which collapses transport failure
and genuine non-registration into the same null — the exact ambiguity
SPEC 3.1 forbids inheriting. This reader performs the identical read
(same contract, same ABI, same uint256 -> hex conversion, 0 means no
entry) and lets failures raise, so the core can return 'unknown'
honestly.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx
from eth_utils import keccak

from .types import WORLD_CHAIN_ID

# Canonical AgentBook deployment on World Chain (SPEC section 2);
# matches AGENT_BOOK_ADDRESS in @worldcoin/agentkit-core 0.2.1.
AGENTBOOK_CONTRACT = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA"

# The World Chain public RPC that viem's worldchain definition (and
# therefore the TS core, when no rpcUrl is configured) falls back to.
DEFAULT_RPC_URL = "https://worldchain-mainnet.g.alchemy.com/public"

_LOOKUP_HUMAN_SELECTOR = "0x" + keccak(b"lookupHuman(address)")[:4].hex()


class RpcError(Exception):
    """A JSON-RPC transport or endpoint failure. Readers raise this (or
    any exception) on failure; None is reserved for 'no entry'."""


def lookup_human_calldata(address: str) -> str:
    return _LOOKUP_HUMAN_SELECTOR + "0" * 24 + address[2:].lower()


class JsonRpcClient:
    """Minimal JSON-RPC 2.0 client over HTTP POST.

    ``trust_env=False`` on purpose: a client for an explicitly
    configured endpoint must not silently route through ambient proxy
    environment variables (the viem transport does not)."""

    def __init__(self, url: str, timeout: float = 10.0):
        self.url = url
        self.timeout = timeout
        self._next_id = 0

    def call(self, method: str, params: list[Any]) -> Any:
        self._next_id += 1
        try:
            with httpx.Client(trust_env=False, timeout=self.timeout) as client:
                response = client.post(
                    self.url,
                    json={
                        "jsonrpc": "2.0",
                        "id": self._next_id,
                        "method": method,
                        "params": params,
                    },
                )
            response.raise_for_status()
            body = response.json()
        except Exception as exc:
            raise RpcError(f"JSON-RPC {method} to {self.url} failed: {exc}") from exc
        if isinstance(body, dict) and body.get("error") is not None:
            raise RpcError(f"JSON-RPC {method} returned an error: {body['error']}")
        if not isinstance(body, dict) or "result" not in body:
            raise RpcError(f"JSON-RPC {method} returned a malformed response")
        return body["result"]

    def chain_id(self) -> int:
        return int(self.call("eth_chainId", []), 16)

    def eth_call(self, to: str, data: str) -> str:
        return self.call("eth_call", [{"to": to, "data": data}, "latest"])


class LiveReader:
    """Reads the AgentBook contract on World Chain directly."""

    source = "live"

    def __init__(
        self,
        rpc_url: Optional[str] = None,
        contract_address: str = AGENTBOOK_CONTRACT,
        client: Optional[JsonRpcClient] = None,
    ):
        self.contract = contract_address
        self.client = client or JsonRpcClient(rpc_url or DEFAULT_RPC_URL)

    def lookup_human(self, address: str) -> Optional[str]:
        # The configured chain only selects transport metadata. The RPC
        # endpoint itself can answer for any chain, so pin its live
        # identity before trusting either a positive or zero AgentBook
        # response (mirrors the TS reader).
        if self.client.chain_id() != WORLD_CHAIN_ID:
            raise RpcError("AgentBook RPC is not World Chain.")
        result = self.client.eth_call(self.contract, lookup_human_calldata(address))
        value = int(result, 16)
        if value == 0:
            return None
        return hex(value)  # minimal lowercase hex, mirroring viem toHex


class StaticReader:
    """A reader that replays fixed responses, for fixture-driven tests
    and offline consumers. Keys are addresses (matched
    case-insensitively); values are a humanId string, None (no entry),
    or an Exception instance to raise."""

    def __init__(
        self,
        entries: dict[str, Any],
        source: str = "fixture",
    ):
        self._entries = {key.lower(): value for key, value in entries.items()}
        self.source = source

    def lookup_human(self, address: str) -> Optional[str]:
        entry = self._entries.get(address.lower())
        if isinstance(entry, BaseException):
            raise entry
        return entry
