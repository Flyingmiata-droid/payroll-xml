"""The column mapper page (docs/mapper.js) turns a payroll export into the CSV the converter reads.

tests/mapper_cases.js runs it under Node on the made-up exports in samples/exports and
checks the result, down to the same bytes as samples/week1.xml for the sample the page offers.
Needs node. The rule check inside it also needs @xmldom/xmldom on NODE_PATH and is skipped without it.
Skips without node, unless REQUIRE_WEB_TESTS=1 is set.
"""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(
    not shutil.which("node") and os.environ.get("REQUIRE_WEB_TESTS") != "1",
    reason="node not found",
)
def test_mapper_cases():
    r = subprocess.run(["node", str(ROOT / "tests" / "mapper_cases.js")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "checks passed" in r.stdout
