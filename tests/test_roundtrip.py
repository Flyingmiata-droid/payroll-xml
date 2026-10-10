import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_sample_converts_and_checks(tmp_path):
    out = tmp_path / "week1.xml"
    r = subprocess.run([sys.executable, "-m", "prlxml.convert", str(ROOT / "samples/week1.csv"), "-o", str(out)], cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert out.exists()
    r = subprocess.run([sys.executable, "-m", "prlxml.check", str(out), "--schemas", str(ROOT / "schemas")], cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
