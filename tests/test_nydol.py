"""New York DOL bulk upload: convert, check, and the browser twin (docs/nydol.js).

Planted errors come in two kinds. Most pass the state schema, so a schema validator alone
misses them; the test proves that when the schema is in schemas/nydol
(python -m prlxml.fetch_schemas ny). The rest are traps where the state's guide page and its
own schema disagree; those fail the schema with a parser message, and the check says what to
write instead.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from lxml import etree

from prlxml import nydol

ROOT = Path(__file__).resolve().parents[1]
CSV = (ROOT / "samples/ny/week1.csv").read_text(encoding="utf-8")
XML = (ROOT / "samples/ny/week1.xml").read_text(encoding="utf-8")
XSD = ROOT / "schemas/nydol" / nydol.NY_XSD
HEAD, *ROWS = CSV.strip("\n").split("\n")
COLS = HEAD.split(",")


def schema_ok(text):
    if not XSD.exists():
        return None
    schema = etree.XMLSchema(etree.parse(str(XSD)))
    return schema.validate(etree.fromstring(text.encode("utf-8")))


def rules(text):
    return nydol.rule_check(nydol.tree_from_lxml(etree.fromstring(text.encode("utf-8"))))


def swap(row, col, value):
    cells = row.split(",")
    cells[COLS.index(col)] = value
    return ",".join(cells)


def csv_with(rows):
    return "\n".join([HEAD] + rows) + "\n"


# ---------- the sample ----------

def test_sample_converts_byte_for_byte():
    assert nydol.convert_csv(CSV) == XML


def test_sample_is_clean():
    assert rules(XML) == ([], [])
    ok = schema_ok(XML)
    if ok is None and os.environ.get("REQUIRE_NY_SCHEMA") == "1":
        pytest.fail("schemas/nydol missing")
    assert ok in (True, None)


@pytest.mark.skipif(not XSD.exists(), reason="run python -m prlxml.fetch_schemas ny")
def test_sample_passes_state_schema():
    assert schema_ok(XML) is True


# ---------- planted errors: the state schema passes them, the check does not ----------

MARIA_SSN = "<ssnLast4>4821</ssnLast4>"

PLANTED = [
    # (name, edit, expected message part)
    ("ssn and dob", lambda x: x.replace("<lastName>Lopez</lastName>\n                <ssnLast4>",
                                        "<lastName>Lopez</lastName>\n                <dateOfBirth>1990-01-01</dateOfBirth>\n                <ssnLast4>", 1),
     "has both ssnLast4 and dateOfBirth"),
    ("no id", lambda x: x.replace("                " + MARIA_SSN + "\n", "", 1), "needs ssnLast4 or dateOfBirth"),
    ("duplicate employee", lambda x: _dup_maria(x), "the state rejects duplicate employees"),
    ("day outside week", lambda x: x.replace("<day>2026-09-28</day>", "<day>2026-09-27</day>", 1), "is outside the week 2026-09-28 to 2026-10-04"),
    ("state abbreviated", lambda x: x.replace("<state>New York</state>", "<state>NY</state>", 1), "must be the full name (New York)"),
    ("other without explanation", lambda x: x.replace("<explanation>Annuity</explanation>", "", 1), "fringe needs an explanation"),
    ("explanation on health", lambda x: x.replace("<type>Health/Welfare</type>\n                    <workCategory>Laborer - Building</workCategory>",
                                                    "<type>Health/Welfare</type>\n                    <workCategory>Laborer - Building</workCategory>\n                    <explanation>Plan A</explanation>", 1),
     "the state takes one only on Other Benefit (Type)"),
    ("negative hours", lambda x: x.replace("<overTimeHours>2.00</overTimeHours>", "<overTimeHours>-2.00</overTimeHours>", 1), "overTimeHours is below 0"),
    ("negative net", lambda x: x.replace("<netWages>1491.97</netWages>", "<netWages>-1491.97</netWages>", 1), "netWages is below 0"),
    ("zero rate", lambda x: x.replace("<stHourlyRate>45.00</stHourlyRate>", "<stHourlyRate>0.00</stHourlyRate>", 1), "stHourlyRate is 0.00"),
]


def _dup_maria(x):
    start = x.index("        <employeeWorkWeek>")
    end = x.index("        </employeeWorkWeek>\n") + len("        </employeeWorkWeek>\n")
    block = x[start:end].replace("Laborer - Building", "Laborer - Heavy and Highway")
    return x[:end] + block + x[end:]


@pytest.mark.parametrize("name,edit,want", PLANTED, ids=[p[0] for p in PLANTED])
def test_planted_error_caught(name, edit, want):
    text = edit(XML)
    assert text != XML, "the edit did not change the file"
    errors, _ = rules(text)
    assert any(want in e for e in errors), errors
    ok = schema_ok(text)
    assert ok in (True, None), f"{name}: the state schema already rejects this, so it is not a planted rule error"


# ---------- traps: guide page and schema disagree ----------

TRAPS = [
    ("apprentice Y", lambda x: x.replace("<nysRegisteredApprentice>false</nysRegisteredApprentice>", "<nysRegisteredApprentice>N</nysRegisteredApprentice>", 1), "write true or false"),
    ("no country", lambda x: x.replace("                    <country>United States</country>\n", "", 1), "address has no country"),
    ("guide page spelling", lambda x: x.replace("deductionsGrossEarnings>1935.00</deductionsGrossEarnings>", "deductionGrossEarnings>1935.00</deductionGrossEarnings>", 1), "deductionsGrossEarnings, with an s"),
    ("week ending with no time", lambda x: x.replace("2026-10-04T00:00:00.000Z", "2026-10-04", 1), "write 2026-10-04T00:00:00.000Z"),
]


@pytest.mark.parametrize("name,edit,want", TRAPS, ids=[t[0] for t in TRAPS])
def test_trap_explained(name, edit, want):
    text = edit(XML)
    assert text != XML
    errors, _ = rules(text)
    assert any(want in e for e in errors), errors
    assert schema_ok(text) in (False, None), f"{name}: expected the state schema to reject this"


# ---------- the state's limits: the schema rejects these, and so does the browser page ----------

LIMITS = [
    ("long first name", lambda x: x.replace("<firstName>Maria</firstName>", "<firstName>" + "M" * 46 + "</firstName>", 1), "firstName is 46 characters"),
    ("long city", lambda x: x.replace("<city>Albany</city>", "<city>" + "A" * 41 + "</city>", 1), "city is 41 characters"),
    ("rate over 999.99", lambda x: x.replace("<stHourlyRate>45.00</stHourlyRate>", "<stHourlyRate>1000.00</stHourlyRate>", 1), "stHourlyRate is 1000.00; the state takes at most 999.99"),
    ("deduction over 9999.99", lambda x: x.replace("<amount>210.00</amount>", "<amount>10000.00</amount>", 1), "the state takes at most 9999.99"),
    ("fringe over 10000", lambda x: x.replace("<standardHourlyRate>12.50</standardHourlyRate>", "<standardHourlyRate>10000.01</standardHourlyRate>", 1), "standardHourlyRate is 10000.01"),
]


@pytest.mark.parametrize("name,edit,want", LIMITS, ids=[t[0] for t in LIMITS])
def test_limit_caught(name, edit, want):
    text = edit(XML)
    assert text != XML
    errors, _ = rules(text)
    assert any(want in e for e in errors), errors
    assert schema_ok(text) in (False, None), f"{name}: expected the state schema to reject this"


def test_dob_in_two_formats_is_one_worker():
    j = [r for r in ROWS if "O'Neill" in r]
    out = nydol.convert_csv(csv_with([swap(j[0], "date_of_birth", "4/17/1999")] + j[1:]))
    assert out.count("<lastName>O'Neill</lastName>") == 1
    assert "<dateOfBirth>1999-04-17</dateOfBirth>" in out


# ---------- warnings ----------

WARNS = [
    ("net does not add up", lambda x: x.replace("<netWages>1491.97</netWages>", "<netWages>1500.00</netWages>", 1), "but netWages is 1500.00"),
    ("underpaid", lambda x: x.replace("<deductionsGrossEarnings>1935.00</deductionsGrossEarnings>", "<deductionsGrossEarnings>1800.00</deductionsGrossEarnings>", 1)
     .replace("<netWages>1491.97</netWages>", "<netWages>1356.97</netWages>", 1), "is below the hours times the rates (1935.00)"),
    ("day twice", lambda x: x.replace("<day>2026-09-29</day>", "<day>2026-09-28</day>", 1), "day 2026-09-28 is listed twice"),
    ("over 24", lambda x: x.replace("<standardTimeHours>8.00</standardTimeHours>\n                            <overTimeHours>2.00</overTimeHours>",
                                    "<standardTimeHours>16.00</standardTimeHours>\n                            <overTimeHours>9.00</overTimeHours>", 1), "more than 24 hours in one day"),
    ("ot rate low", lambda x: x.replace("<otHourlyRate>67.50</otHourlyRate>", "<otHourlyRate>40.00</otHourlyRate>", 1), "otHourlyRate 40.00 is below stHourlyRate 45.00"),
    ("fringe for another class", lambda x: x.replace("<workCategory>Laborer - Building</workCategory>\n                    <standardHourlyRate>12.50",
                                                     "<workCategory>Electrician</workCategory>\n                    <standardHourlyRate>12.50", 1), "not one of this worker's classifications"),
]


@pytest.mark.parametrize("name,edit,want", WARNS, ids=[w[0] for w in WARNS])
def test_warning(name, edit, want):
    text = edit(XML)
    assert text != XML
    errors, warnings = rules(text)
    assert errors == [], errors
    assert any(want in w for w in warnings), warnings


# ---------- convert ----------

M0, M1 = ROWS[0], ROWS[1]

REFUSALS = [
    ("two projects", csv_with([M0, swap(M1, "prc_number", "2025009999")]), "a file holds one project"),
    ("two weeks", csv_with([M0, swap(M1, "week_ending", "2026-10-11")]), "a file holds one week"),
    ("ssn and dob", csv_with([swap(M0, "date_of_birth", "1990-01-01")]), "not both and not neither"),
    ("day outside week", csv_with([swap(M0, "work_date", "2026-10-05")]), "is outside the week 2026-09-28 to 2026-10-04"),
    ("day twice", csv_with([M0, M0]), "is listed twice for Maria Lopez"),
    ("rate 3 decimals", csv_with([swap(M0, "st_rate", "45.125")]), "st_rate '45.125' is not a number with at most 2 decimals"),
    ("rows disagree", csv_with([M0, swap(M1, "net_wages", "1491.98")]), "net_wages '1491.98' differs from row 2"),
    ("other no explanation", csv_with([swap(M0, "other", "1.00")]), "an other fringe needs other_explanation"),
    ("bad zip", csv_with([swap(M0, "zip", "12AB")]), "is not a 5 digit ZIP"),
    ("apprentice maybe", csv_with([swap(M0, "apprentice", "maybe")]), "must be Y or N"),
    ("short prc", csv_with([swap(M0, "prc_number", "12345")]), "must be 10 characters"),
    ("missing column", "last_name,first_name\nLopez,Maria\n", "missing columns: prc_number"),
    ("over 24 hours", csv_with([swap(M0, "st_hours", "25")]), "at most 24 hours"),
    ("long name", csv_with([swap(M0, "last_name", "L" * 46)]), "last_name is 46 characters; the state takes at most 45"),
    ("long address", csv_with([swap(M0, "address1", "A" * 43)]), "address1 is 43 characters; the state takes at most 42"),
    ("rate over 999.99", csv_with([swap(M0, "st_rate", "1000.00")]), "st_rate is 1000.00; the state takes at most 999.99"),
    ("gross over limit", csv_with([swap(M0, "gross_earnings", "1000000.00")]), "gross_earnings is 1000000.00; the state takes at most 999999.99"),
    ("deduction over 9999.99", csv_with([swap(M0, "deductions", "Federal Tax:10000.00")]), "the state takes at most 9999.99"),
    ("fringe over limit", csv_with([swap(M0, "health", "10000.01")]), "health is 10000.01; the state takes at most 10000.00"),
]


@pytest.mark.parametrize("name,text,want", REFUSALS, ids=[r[0] for r in REFUSALS])
def test_convert_refuses(name, text, want):
    with pytest.raises(nydol.ConvertError) as e:
        nydol.convert_csv(text)
    assert want in str(e.value)


def test_convert_cleans_up():
    row = swap(swap(swap(swap(M0, "ssn_last4", "123-45-4821"), "state", "ny"), "zip", "7024"), "work_date", "9/28/2026")
    row = swap(row, "week_ending", "10/4/2026")
    out = nydol.convert_csv(csv_with([row]))
    assert "<ssnLast4>4821</ssnLast4>" in out and "123-45" not in out
    assert "<state>New York</state>" in out
    assert "<postalCode>07024</postalCode>" in out
    assert "<weekEndingDate>2026-10-04T00:00:00.000Z</weekEndingDate>" in out
    assert "<day>2026-09-28</day>" in out
    assert schema_ok(out) in (True, None)


def test_convert_reads_excel_csv():
    text = csv_with([swap(M0, "last_name", "Pe\u00f1a")]).encode("cp1252")
    out = nydol.convert_csv(nydol.decode_csv_bytes(text))
    assert "<lastName>Pe\u00f1a</lastName>" in out


def test_no_deductions_no_fringes_still_schema_valid():
    row = M0
    for c in ("deductions", "health", "pension", "training"):
        row = swap(row, c, "")
    out = nydol.convert_csv(csv_with([row]))
    assert "<deductions/>" in out and "<supplementalPayments/>" in out
    assert schema_ok(out) in (True, None)


# ---------- the browser twin gives the same answers ----------

def _node_ready():
    if not shutil.which("node"):
        return False
    return subprocess.run(["node", "-e", "require('@xmldom/xmldom')"], capture_output=True).returncode == 0


needs_node = pytest.mark.skipif(
    not _node_ready() and os.environ.get("REQUIRE_WEB_TESTS") != "1",
    reason="node with @xmldom/xmldom not found",
)


def _cases():
    cases = {"sample.csv": CSV.encode("utf-8"), "sample.xml": XML.encode("utf-8")}
    for name, text, _ in REFUSALS:
        cases[f"refuse {name}.csv"] = text.encode("utf-8")
    for group in (PLANTED, TRAPS, LIMITS, WARNS):
        for name, edit, _ in group:
            cases[f"{name}.xml"] = edit(XML).encode("utf-8")
    cases["excel.csv"] = csv_with([swap(M0, "last_name", "Pe\u00f1a")]).encode("cp1252")
    row = swap(swap(swap(swap(M0, "ssn_last4", "123-45-4821"), "state", "ny"), "zip", "7024"), "work_date", "9/28/2026")
    cases["cleanup.csv"] = csv_with([swap(row, "week_ending", "10/4/2026")]).encode("utf-8")
    cases["quoted.csv"] = csv_with([swap(M0, "address1", '"41 Elm St, Unit 3"')]).encode("utf-8")
    return cases


def _python(name, data):
    if name.endswith(".csv"):
        try:
            return {"xml": nydol.convert_csv(nydol.decode_csv_bytes(data))}
        except nydol.ConvertError as e:
            return {"error": str(e)}
    errors, warnings = rules(data.decode("utf-8"))
    return {"errors": errors, "warnings": warnings}


@needs_node
def test_browser_matches_python(tmp_path):
    cases = _cases()
    for name, data in cases.items():
        (tmp_path / name).write_bytes(data)
    r = subprocess.run(["node", str(ROOT / "tests/ny_parity.js"), str(tmp_path)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    web = json.loads(r.stdout)
    assert web.pop("__sample__") == CSV, "docs/nydol.js SAMPLE_CSV differs from samples/ny/week1.csv"
    assert web.pop("__template__") == HEAD + "\n"
    assert sorted(web) == sorted(cases)
    for name, data in cases.items():
        assert web[name] == _python(name, data), name
