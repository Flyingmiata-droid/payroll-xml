"""Checking several files at once: files that clash with each other.

Payroll XML: two files with the same payroll number for one vendor and contract, or
two payrolls whose periods share days. New York: two files for one PRC number and the
same week ending date. These are warnings; they do not change the exit code. The
browser pages (docs/prlxml.js, docs/nydol.js) must give the same lines (tests/across_parity.js).
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from prlxml import check, nydol

ROOT = Path(__file__).resolve().parents[1]
PRL = (ROOT / "samples/week1.xml").read_text(encoding="utf-8")
NY = (ROOT / "samples/ny/week1.xml").read_text(encoding="utf-8")


def _prl(number="1", begin="2026-10-04", end="2026-10-10", contract="20260001", vendor="V1001"):
    s = PRL.replace("<payrollNumber>1<", f"<payrollNumber>{number}<")
    s = s.replace("<payrollBeginDate>2026-10-04<", f"<payrollBeginDate>{begin}<")
    s = s.replace("<payrollEndDate>2026-10-10<", f"<payrollEndDate>{end}<")
    s = s.replace("<contractID>20260001<", f"<contractID>{contract}<")
    return s.replace("<vendorID>V1001<", f"<vendorID>{vendor}<")


def _ny(prc="2025001234", week="2026-10-04"):
    s = NY.replace("<prcNumber>2025001234<", f"<prcNumber>{prc}<")
    return s.replace("<weekEndingDate>2026-10-04T", f"<weekEndingDate>{week}T")


def _write(d, files):
    for name, text in files.items():
        (d / name).write_text(text, encoding="utf-8")
    return [d / n for n in sorted(files)]


CASES = {
    "a1.xml": _prl(),
    "a2.xml": _prl(),                                   # same number, same contract: warn
    "a3.xml": _prl("2"),                                # overlaps a1 and a2: warn twice
    "a4.xml": _prl("3", "2026-10-11", "2026-10-17"),    # next week: fine
    "a5.xml": _prl("1", contract="20260002"),           # other contract: fine
    "a6.xml": _prl("1", vendor="V2002"),                # a sub on the same contract: fine
    "a7.xml": _prl("4", "2026-10-17", "2026-10-23"),    # shares 10-17 with a4: warn
    "a8.xml": _prl("5", "bad", "2026-10-23"),           # bad date: no overlap claim
    "b1.xml": "<Payroll",                               # unreadable: left out
    "n1.xml": _ny(),
    "n2.xml": _ny(),                                    # same PRC and week: warn
    "n3.xml": _ny(week="2026-10-11"),                   # next week: fine
    "n4.xml": _ny(prc="2025009999"),                    # other project: fine
}


def test_prl_across(tmp_path):
    paths = _write(tmp_path, CASES)
    got = check.across([(p.name, check.header(p)) for p in paths])
    assert got == [
        "a1.xml and a2.xml are both payroll number 1 for contract 20260001, vendor V1001. If one is not a correction of the other, renumber it",
        "a1.xml (payroll 1, 2026-10-04 to 2026-10-10) and a3.xml (payroll 2, 2026-10-04 to 2026-10-10) cover the same days for contract 20260001, vendor V1001",
        "a2.xml (payroll 1, 2026-10-04 to 2026-10-10) and a3.xml (payroll 2, 2026-10-04 to 2026-10-10) cover the same days for contract 20260001, vendor V1001",
        "a4.xml (payroll 3, 2026-10-11 to 2026-10-17) and a7.xml (payroll 4, 2026-10-17 to 2026-10-23) cover the same days for contract 20260001, vendor V1001",
    ]


def test_ny_across(tmp_path):
    paths = _write(tmp_path, CASES)
    got = nydol.across([(p.name, nydol.header(p)) for p in paths])
    assert got == [
        "n1.xml and n2.xml are both PRC 2025001234, week ending 2026-10-04. The state takes one file per project per week; if one is not a correction of the other, check the week",
    ]


def test_cli_several_files(tmp_path):
    paths = _write(tmp_path, {k: CASES[k] for k in ("a1.xml", "a2.xml", "a5.xml")})
    r = subprocess.run([sys.executable, "-m", "prlxml.check", *map(str, paths), "--schemas", str(ROOT / "schemas")],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr  # a clash is a warning, not an error
    assert r.stdout.count("== ") == 4
    assert "WARN    " in r.stdout and "are both payroll number 1" in r.stdout
    assert r.stdout.rstrip().endswith("3 files: 3 OK, 0 with errors, 1 warning across files")
    paths = _write(tmp_path, {"a1.xml": CASES["a1.xml"], "b1.xml": CASES["b1.xml"]})
    r = subprocess.run([sys.executable, "-m", "prlxml.check", *map(str, paths), "--schemas", str(ROOT / "schemas")],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 1
    assert r.stdout.rstrip().endswith("2 files: 1 OK, 1 with errors")


def test_cli_ny_several_files(tmp_path):
    paths = _write(tmp_path, {k: CASES[k] for k in ("n1.xml", "n2.xml", "n4.xml")})
    r = subprocess.run([sys.executable, "-m", "prlxml.nydol", "check", *map(str, paths), "--schemas", str(ROOT / "schemas/nydol")],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "are both PRC 2025001234, week ending 2026-10-04" in r.stdout
    assert r.stdout.rstrip().endswith("3 files: 3 OK, 0 with errors, 1 warning across files")


def _node_ready():
    if not shutil.which("node"):
        return False
    return subprocess.run(["node", "-e", "require('@xmldom/xmldom')"], capture_output=True, cwd=ROOT).returncode == 0


needs_node = pytest.mark.skipif(
    not _node_ready() and os.environ.get("REQUIRE_WEB_TESTS") != "1",
    reason="node with @xmldom/xmldom not found",
)


@needs_node
def test_browser_gives_same_lines(tmp_path):
    paths = _write(tmp_path, CASES)
    r = subprocess.run(["node", str(ROOT / "tests/across_parity.js"), str(tmp_path)], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stderr
    web = json.loads(r.stdout)
    assert web["prl"]["headers"] == {p.name: check.header(p) for p in paths}
    assert web["ny"]["headers"] == {p.name: nydol.header(p) for p in paths}
    assert web["prl"]["warnings"] == check.across([(p.name, check.header(p)) for p in paths])
    assert web["ny"]["warnings"] == nydol.across([(p.name, nydol.header(p)) for p in paths])


def test_star_is_expanded(tmp_path):
    """Windows cmd does not expand *.xml; the tool does."""
    _write(tmp_path, {k: CASES[k] for k in ("a1.xml", "a2.xml")})
    r = subprocess.run([sys.executable, "-m", "prlxml.check", str(tmp_path / "*.xml"), "--schemas", str(ROOT / "schemas")],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.rstrip().endswith("2 files: 2 OK, 0 with errors, 1 warning across files")
    r = subprocess.run([sys.executable, "-m", "prlxml.check", str(tmp_path / "none*.xml"), "--schemas", str(ROOT / "schemas")],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 1  # no match: the pattern is checked as a file name, and is not there


def test_bom_in_a_field_same_both_sides(tmp_path):
    """A stray U+FEFF at the edge of a field: Python must read it the way JS trim() does."""
    files = {"a1.xml": CASES["a1.xml"], "a9.xml": _prl("9").replace("<payrollBeginDate>", "<payrollBeginDate>\ufeff"),
             "n1.xml": CASES["n1.xml"], "n9.xml": _ny().replace("<weekEndingDate>", "<weekEndingDate>\ufeff")}
    paths = _write(tmp_path, files)
    assert len(check.across([(p.name, check.header(p)) for p in paths])) == 1
    assert len(nydol.across([(p.name, nydol.header(p)) for p in paths])) == 1
    if _node_ready():
        r = subprocess.run(["node", str(ROOT / "tests/across_parity.js"), str(tmp_path)], capture_output=True, text=True, cwd=ROOT)
        web = json.loads(r.stdout)
        assert web["prl"]["warnings"] == check.across([(p.name, check.header(p)) for p in paths])
        assert web["ny"]["warnings"] == nydol.across([(p.name, nydol.header(p)) for p in paths])


def test_same_file_twice_checked_once(tmp_path):
    paths = _write(tmp_path, {"a1.xml": CASES["a1.xml"], "a5.xml": CASES["a5.xml"]})
    r = subprocess.run([sys.executable, "-m", "prlxml.check", str(paths[0]), str(tmp_path / "*.xml"), "--schemas", str(ROOT / "schemas")],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout
    assert r.stdout.rstrip().endswith("2 files: 2 OK, 0 with errors")
