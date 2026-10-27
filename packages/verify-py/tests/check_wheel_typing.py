"""Check that a clean wheel install exposes the typed public API."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: check_wheel_typing.py WHEEL_DIRECTORY")
    wheels = list(Path(sys.argv[1]).glob("fiador_verify-*.whl"))
    if len(wheels) != 1:
        raise AssertionError(f"expected one fiador-verify wheel, found {len(wheels)}")
    wheel = wheels[0].resolve()
    with zipfile.ZipFile(wheel) as archive:
        assert "fiador_verify/py.typed" in archive.namelist(), "wheel lacks py.typed"

    with tempfile.TemporaryDirectory(prefix="fiador-wheel-type-") as directory:
        root = Path(directory)
        env_dir = root / "venv"
        venv.EnvBuilder(with_pip=True).create(env_dir)
        interpreter = env_dir / "bin" / "python"
        subprocess.run(
            [str(interpreter), "-m", "pip", "install", "--quiet", str(wheel)],
            check=True,
        )
        probe = root / "consumer.py"
        probe.write_text(
            "from typing import assert_type\n"
            "from fiador_verify import VerifyResult, create_verifier\n"
            "result = create_verifier().verify_address('0x' + '00' * 20)\n"
            "assert_type(result, VerifyResult)\n",
            encoding="utf-8",
        )
        environment = os.environ.copy()
        environment.pop("PYTHONPATH", None)
        subprocess.run(
            [
                sys.executable,
                "-m",
                "mypy",
                "--strict",
                "--python-executable",
                str(interpreter),
                str(probe),
            ],
            cwd=root,
            env=environment,
            check=True,
        )
    print("Installed wheel is PEP 561 typed; create_verifier retains VerifyResult.")


if __name__ == "__main__":
    main()
