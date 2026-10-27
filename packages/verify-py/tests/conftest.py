"""Shared test fixtures.

The parity source is the TypeScript package's committed fixture file,
read from the sibling path at test time — never copied. If the TS
vectors change, these tests must fail loudly until the port is
reconciled (W1 DESIGN 4.1's cross-language conformance rule).
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from fiador_verify import create_verifier
from fiador_verify.reader import StaticReader
from fiador_verify.types import AttestationPayloadV1, SignedAttestation, Subject

VECTORS_PATH = (
    Path(__file__).resolve().parents[2] / "verify-ts" / "fixtures" / "vectors.json"
)


def load_vectors() -> dict[str, Any]:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


def parse_z(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def fmt_z(dt: datetime) -> str:
    utc = dt.astimezone(timezone.utc)
    return f"{utc:%Y-%m-%dT%H:%M:%S}.{utc.microsecond // 1000:03d}Z"


def payload_from_dict(d: dict[str, Any]) -> AttestationPayloadV1:
    return AttestationPayloadV1(
        version=d["version"],
        subject=Subject(type=d["subject"]["type"], id=d["subject"]["id"]),
        agent_wallet_address=d["agentWalletAddress"],
        attestation_url=d.get("attestationUrl"),
        operator_display_name=d.get("operatorDisplayName"),
        human_id_disclosure=d["humanIdDisclosure"],
        issued_at=d["issuedAt"],
        expires_at=d["expiresAt"],
        nonce=d["nonce"],
        extra=d.get("extra"),
    )


def attestation_from_dict(d: dict[str, Any]) -> SignedAttestation:
    return SignedAttestation(
        payload=payload_from_dict(d["payload"]),
        signature=d["signature"],
        signature_type=d["signatureType"],
    )


@pytest.fixture(scope="session")
def vectors() -> dict[str, Any]:
    return load_vectors()


@pytest.fixture(scope="session")
def fixed_now(vectors: dict[str, Any]) -> datetime:
    return parse_z(vectors["fixedNow"])


def static_reader_from_vectors(
    vectors: dict[str, Any], source: str = "live"
) -> StaticReader:
    entries = {row["address"]: row["humanId"] for row in vectors["lookups"]}
    return StaticReader(entries, source=source)


def make_verifier(vectors: dict[str, Any], fixed_now: datetime, **overrides: Any):
    """A verifier over the fixture reader at the fixture clock, like
    the TS test-suite's factory."""
    options: dict[str, Any] = {
        "reader": static_reader_from_vectors(vectors),
        "now": lambda: fixed_now,
    }
    options.update(overrides)
    return create_verifier(**options)


class StubRpc:
    """A local JSON-RPC stub server, mirroring the TS tests' stubbed
    RPC. Answers eth_chainId with a configurable chain and eth_call
    with a configurable result or error; counts eth_chainId and
    eth_call invocations. With hang_eth_call=True an eth_call is
    accepted and never answered (the 7.5 B1 deadline tests)."""

    def __init__(
        self,
        chain_id: str = "0x1e0",  # 480
        eth_call_result: str | None = None,
        eth_call_error: bool = False,
        eth_call_status: int | None = None,
        hang_eth_call: bool = False,
    ):
        self.chain_id = chain_id
        self.eth_call_result = eth_call_result
        self.eth_call_error = eth_call_error
        self.eth_call_status = eth_call_status
        self.hang_eth_call = hang_eth_call
        self.eth_calls = 0
        self.chain_id_calls = 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 (stdlib naming)
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length) or b"{}")
                method = body.get("method")
                if method == "eth_chainId":
                    outer.chain_id_calls += 1
                if method == "eth_call":
                    outer.eth_calls += 1
                    if outer.eth_call_status is not None:
                        self.send_error(outer.eth_call_status)
                        return
                    if outer.hang_eth_call:
                        # Never respond: the client must bound this
                        # with its own deadline, not ours.
                        threading.Event().wait(30)
                        return
                    if outer.eth_call_error:
                        payload = {
                            "jsonrpc": "2.0",
                            "id": body.get("id"),
                            "error": {"code": -32000, "message": "execution reverted"},
                        }
                    else:
                        payload = {
                            "jsonrpc": "2.0",
                            "id": body.get("id"),
                            "result": outer.eth_call_result,
                        }
                else:
                    payload = {
                        "jsonrpc": "2.0",
                        "id": body.get("id"),
                        "result": outer.chain_id,
                    }
                raw = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):  # silence
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        # A hanging eth_call handler must not hold test teardown open.
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "StubRpc":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._server.shutdown()
        self._server.server_close()


# The ERC-1271 magic value as a stubbed eth_call result (bytes4 + padding).
MAGIC_RESULT = "0x1626ba7e" + "00" * 28
# A positive AgentBook lookup: uint256 1.
POSITIVE_LOOKUP_RESULT = "0x" + "0" * 63 + "1"
