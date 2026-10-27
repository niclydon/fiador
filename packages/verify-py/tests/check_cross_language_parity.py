"""Diff complete normalized TS and Python results for shared W0 vectors.

Run after building packages/verify-ts. Only measured RPC latency is
normalized; every other internal/public result field is compared.
All inputs are the committed synthetic fixture set.
"""

from __future__ import annotations

import copy
import difflib
import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from fiador_verify import (
    canonical_attestation_message,
    create_verifier,
    hash_human_id,
    to_public_verify_result,
)
from fiador_verify.reader import StaticReader
from fiador_verify.types import AttestedSubject, Subject

HERE = Path(__file__).resolve().parent
VECTORS = HERE.parent.parent / "verify-ts" / "fixtures" / "vectors.json"


def camel(key: str) -> str:
    first, *rest = key.split("_")
    return first + "".join(piece[:1].upper() + piece[1:] for piece in rest)


def normalize(value: Any) -> Any:
    if isinstance(value, dict):
        out = {camel(key): normalize(item) for key, item in value.items()}
        if "rpcLatencyMs" in out:
            out["rpcLatencyMs"] = "<elapsed>"
        return out
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value


def pair(result: Any) -> dict[str, Any]:
    return {
        "internal": normalize(result.to_dict()),
        "public": normalize(to_public_verify_result(result).to_dict()),
    }


def python_output(vectors: dict[str, Any]) -> dict[str, Any]:
    fixed_now = datetime.fromisoformat(vectors["fixedNow"].replace("Z", "+00:00"))
    entries = {row["address"]: row["humanId"] for row in vectors["lookups"]}
    verifier = create_verifier(
        reader=StaticReader(entries, source="fixture"), now=lambda: fixed_now
    )
    output: dict[str, Any] = {
        "canonical": {},
        "hashes": {},
        "results": {},
        "signedMessages": {},
    }
    for name, human_id in vectors["humans"].items():
        output["hashes"][name] = hash_human_id(human_id)
    for row in vectors["lookups"]:
        output["results"]["address/" + row["address"]] = pair(
            verifier.verify_address(row["address"])
        )
    output["results"]["address/malformed"] = pair(
        verifier.verify_address("not-an-address")
    )
    for name, attestation in vectors["attestations"].items():
        output["canonical"][name] = canonical_attestation_message(
            attestation["payload"]
        )
        output["results"]["attestation/" + name] = pair(
            verifier.verify_attestation(attestation)
        )
    valid = vectors["attestations"]["valid"]
    output["results"]["attestation/no-registration"] = pair(
        verifier.verify_attestation(valid, check_registration=False)
    )
    for field in ("attestationUrl", "operatorDisplayName", "extra"):
        with_null = copy.deepcopy(valid)
        with_null["payload"][field] = None
        output["results"]["attestation/null-" + field] = pair(
            verifier.verify_attestation(with_null)
        )
    output["results"]["resolve/address"] = pair(
        verifier.resolve_status(
            {"kind": "address", "address": vectors["wallets"]["operatorA"]}
        )
    )
    output["results"]["resolve/attestation"] = pair(
        verifier.resolve_status({"kind": "attestation", "attestation": valid})
    )
    subject = Subject(**valid["payload"]["subject"])
    output["results"]["resolve/attested-subject"] = pair(
        verifier.resolve_status(
            AttestedSubject(subject=subject, resolve_attestation=lambda _subject: valid)
        )
    )
    output["results"]["resolve/missing"] = pair(
        verifier.resolve_status(
            AttestedSubject(subject=subject, resolve_attestation=lambda _subject: None)
        )
    )

    class OfflineReader:
        source = "fixture"

        def lookup_human(self, _address: str) -> str:
            raise RuntimeError("synthetic offline reader")

    offline = create_verifier(reader=OfflineReader(), now=lambda: fixed_now)
    output["results"]["address/lookup-failed"] = pair(
        offline.verify_address(vectors["wallets"]["operatorA"])
    )

    seen: set[str] = set()

    class NonceStore:
        def has(self, nonce: str, wallet: str) -> bool:
            return wallet + ":" + nonce in seen

        def claim(self, nonce: str, wallet: str, expires_at: str) -> str:
            key = wallet + ":" + nonce
            if key in seen:
                return "replay"
            expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if expiry <= fixed_now:
                return "expired"
            seen.add(key)
            return "claimed"

    store = NonceStore()
    output["results"]["nonce/first"] = pair(
        verifier.verify_attestation(valid, nonce_store=store)
    )
    output["results"]["nonce/replay"] = pair(
        verifier.verify_attestation(valid, nonce_store=store)
    )
    for name, vector in vectors["signedMessages"].items():
        output["signedMessages"][name + "/expected"] = normalize(
            verifier.verify_signed_message(
                vector["message"],
                vector["signature"],
                "eoa",
                expected_address=vector["signer"],
            ).to_dict()
        )
        output["signedMessages"][name + "/bare"] = normalize(
            verifier.verify_signed_message(
                vector["message"], vector["signature"], "eoa"
            ).to_dict()
        )
    return output


def main() -> None:
    vectors = json.loads(VECTORS.read_text(encoding="utf-8"))
    assert vectors["lookups"] and vectors["attestations"] and vectors["signedMessages"]
    ts = subprocess.run(
        ["node", str(HERE / "parity_ts.mjs")],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    ts_output = json.loads(ts.stdout)
    py_output = python_output(vectors)
    if ts_output != py_output:
        ts_lines = json.dumps(ts_output, indent=2, sort_keys=True).splitlines()
        py_lines = json.dumps(py_output, indent=2, sort_keys=True).splitlines()
        diff = "\n".join(
            difflib.unified_diff(ts_lines, py_lines, fromfile="TypeScript", tofile="Python")
        )
        raise AssertionError("Cross-language fixture parity failed:\n" + diff)
    print(
        f"Cross-language parity passed: {len(py_output['results'])} complete result pairs, "
        f"{len(py_output['signedMessages'])} signed messages, "
        f"{len(py_output['canonical'])} canonical messages."
    )


if __name__ == "__main__":
    main()
