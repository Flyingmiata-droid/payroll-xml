"""The browser page (docs/prlxml.js) must give the same answers as the Python tool.

Writes a set of CSV and XML cases, runs the Python convert and check on each,
runs docs/prlxml.js on the same files under Node (tests/web_parity.js), and
compares. Converted XML must match byte for byte. Error messages must match word
for word.

Needs node and @xmldom/xmldom on NODE_PATH. Skips without them, unless
REQUIRE_WEB_TESTS=1 is set (CI sets it).
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from prlxml import check, convert

ROOT = Path(__file__).resolve().parents[1]
SAMPLE_CSV = (ROOT / "samples/week1.csv").read_text(encoding="utf-8")
SAMPLE_XML = (ROOT / "samples/week1.xml").read_text(encoding="utf-8")
HEADER, *DATA = SAMPLE_CSV.strip("\n").split("\n")
MALFORMED = "not well-formed XML: "


def _node_ready():
    if not shutil.which("node"):
        return False
    r = subprocess.run(["node", "-e", "require('@xmldom/xmldom')"], capture_output=True)
    return r.returncode == 0


needs_node = pytest.mark.skipif(
    not _node_ready() and os.environ.get("REQUIRE_WEB_TESTS") != "1",
    reason="node with @xmldom/xmldom not found",
)


def _swap(line, col, value):
    cols = HEADER.split(",")
    cells = line.split(",")
    cells[cols.index(col)] = value
    return ",".join(cells)


def _csv(lines, newline="\n"):
    return newline.join(lines) + newline


def csv_cases():
    c = {}
    c["c01_sample.csv"] = SAMPLE_CSV
    c["c02_crlf_bom.csv"] = "\ufeff" + _csv([HEADER] + DATA, "\r\n")
    c["c03_blank_rows.csv"] = _csv([HEADER] + DATA[:3] + [""] + DATA[3:] + ["," * 29, "," * 29])
    quoted = [_swap(_swap(d, "last_name", '"Garcia, Jr."'), "first_name", '"Luis ""Lu"""') for d in DATA[:5]]
    c["c04_quoted.csv"] = _csv([HEADER] + quoted + DATA[5:])
    money = [_swap(_swap(_swap(d, "st_rate", "28.505"), "ot_rate", "42.755"), "gross_pay", '"$1,239.75"') for d in DATA[:5]]
    money[1] = _swap(money[1], "st_hours", "1.2e1")
    c["c05_rounding.csv"] = _csv([HEADER] + money + DATA[5:])
    mixed = [_swap(_swap(d, "gender", "m"), "apprentice", "Yes") for d in DATA[:5]]
    mixed += [_swap(d, "gender", "F") for d in DATA[5:]]
    c["c06_gender_apprentice.csv"] = _csv([HEADER] + mixed)
    c["c07_full_ssn.csv"] = _csv([HEADER] + [_swap(d, "ssn", "123-45-6789") for d in DATA[:5]] + DATA[5:])
    ded = [_swap(d, "other_deductions", "Union dues:38.37; Child support: 50") for d in DATA[:5]]
    ded += [_swap(d, "other_deductions", ";;") for d in DATA[5:]]
    c["c08_deductions.csv"] = _csv([HEADER] + ded)
    c["c09_header_spaces.csv"] = _csv([", ".join(HEADER.split(","))] + DATA)
    names = [_swap(d, "last_name", '"O\'Brien & Sons <x>"') for d in DATA[:5]]
    names += [_swap(d, "last_name", "Mu\u00f1oz") for d in DATA[5:]]
    c["c10_escapes_utf8.csv"] = _csv([HEADER] + names)
    two = [_swap(_swap(d, "labor_class", "102"), "craft_code", "100") for d in DATA[:2]]
    c["c11_two_classes_interleaved.csv"] = _csv([HEADER, DATA[0], DATA[5], two[0], DATA[1], DATA[6], two[1]] + DATA[2:5] + DATA[7:])
    # error cases
    c["e01_missing_column.csv"] = _csv([HEADER.replace(",medicare", "")] + [d.rsplit(",", 2)[0] + "," + d.rsplit(",", 1)[1] for d in DATA])
    c["e02_vendor_differs.csv"] = _csv([HEADER] + DATA[:9] + [_swap(DATA[9], "vendor_id", "V2002")])
    c["e03_bad_hours.csv"] = _csv([HEADER] + DATA[:4] + [_swap(DATA[4], "st_hours", "eight")] + DATA[5:])
    c["e04_bad_payroll_number.csv"] = _csv([HEADER] + [_swap(d, "payroll_number", "1.0") for d in DATA])
    c["e05_deduction_no_colon.csv"] = _csv([HEADER] + [_swap(d, "other_deductions", "Union dues 38") for d in DATA[:5]] + DATA[5:])
    c["e06_no_rows.csv"] = _csv([HEADER, "," * 29])
    c["e07_nan.csv"] = _csv([HEADER] + [_swap(d, "gross_pay", "NaN") for d in DATA[:5]] + DATA[5:])
    # encodings and Excel habits
    accented = [_swap(d, "last_name", "Mu\u00f1oz") for d in DATA[5:]]
    c["c12_cp1252.csv"] = _csv([HEADER] + DATA[:5] + accented).encode("cp1252")
    us = [_swap(_swap(_swap(d, "period_begin", "10/4/2026"), "period_end", "10/10/2026"), "work_date", "/".join(str(int(x)) for x in [d.split(",")[19][5:7], d.split(",")[19][8:10], d.split(",")[19][:4]])) for d in DATA]
    c["c13_us_dates.csv"] = _csv([HEADER] + us)
    c["c14_leading_blank_line.csv"] = "\n\n" + SAMPLE_CSV
    zeros = [_swap(_swap(d, "state_tax", "-0.00"), "ot_hours", "-1.13687E-13") if d.split(",")[21] == "0.00" else d for d in DATA]
    c["c15_negative_zero.csv"] = _csv([HEADER] + zeros)
    c["e08_mixed_encoding.csv"] = _csv([HEADER] + DATA[:5] + accented).encode("utf-8").replace(b"Garcia", b"Garc\x92a", 1)
    c["e09_control_char.csv"] = _csv([HEADER] + [_swap(d, "last_name", "Garcia\x0bJr") for d in DATA[:5]] + DATA[5:])
    c["e10_nbsp_number.csv"] = _csv([HEADER] + [_swap(d, "gross_pay", "1\u00a0239.75") for d in DATA[:5]] + DATA[5:])
    c["e11_cp1252_hole.csv"] = _csv([HEADER] + DATA).encode("cp1252").replace(b"Garcia", b"Garc\x81a", 1)
    c["e12_gross_differs.csv"] = _csv([HEADER] + DATA[:3] + [_swap(DATA[3], "gross_pay", "1240.00")] + DATA[4:])
    c["e13_gender_differs.csv"] = _csv([HEADER] + DATA[:6] + [_swap(DATA[6], "gender", "Male")] + DATA[7:])
    c["c16_same_value_spelled_two_ways.csv"] = _csv([HEADER] + DATA[:3] + [_swap(_swap(DATA[3], "gross_pay", '"$1,239.75"'), "gender", "M")] + DATA[4:])
    return c


def xml_cases():
    s = SAMPLE_XML
    c = {}
    c["x01_sample.xml"] = s
    c["x02_eight_day_period.xml"] = s.replace("<payrollEndDate>2026-10-10<", "<payrollEndDate>2026-10-11<")
    c["x03_payroll_zero.xml"] = s.replace("<payrollNumber>1<", "<payrollNumber>0<")
    c["x04_contract_dash.xml"] = s.replace("<contractID>20260001<", "<contractID>2026-0001<")
    c["x05_gender_letter.xml"] = s.replace("<gender>Male<", "<gender>M<")
    c["x06_no_change_indicator.xml"] = s.replace("<changeIndicator>true</changeIndicator>", "", 1)
    c["x07_two_letter_initial.xml"] = s.replace("<middleInitial>A<", "<middleInitial>AB<")
    c["x08_dashed_ssn.xml"] = s.replace("<PartialSsn>1234</PartialSsn>", "<socialSecurityNumber>123-45-6789</socialSecurityNumber>")
    c["x09_hours_outside.xml"] = s.replace("<laborHourDate>2026-10-09<", "<laborHourDate>2026-10-12<", 1)
    c["x10_empty_overtime.xml"] = s.replace("<overtimeHours>1.00</overtimeHours>\n" + " " * 14 + "</hourlyHours>", "<overtimeHours></overtimeHours>\n" + " " * 14 + "</hourlyHours>", 1)
    c["x11_total_mismatch.xml"] = s.replace("<straightTimeHours>40.00</straightTimeHours>", "<straightTimeHours>41.00</straightTimeHours>", 1)
    c["x12_net_mismatch.xml"] = s.replace("<txl:amount>958.54<", "<txl:amount>958.55<")
    c["x13_long_name.xml"] = s.replace("<lastName>Garcia<", "<lastName>" + "G" * 41 + "<")
    c["x14_wrong_namespace.xml"] = s.replace("http://www.transxml.net/schema/prl/1.2", "http://www.transxml.net/schema/prl/1.1")
    c["x15_not_payroll.xml"] = s.replace("<Payroll ", "<Timesheet ").replace("</Payroll>", "</Timesheet>")
    c["x16_bad_dates.xml"] = s.replace("<payrollBeginDate>2026-10-04<", "<payrollBeginDate>2026-02-30<")
    c["x17_hours_not_numbers.xml"] = s.replace("<straightTimeHours>8.00</straightTimeHours>", "<straightTimeHours>eight</straightTimeHours>", 1)
    c["x18_padded_text.xml"] = s.replace("<lastName>Garcia<", "<lastName>  Garcia  <").replace("<txl:amount>958.54<", "<txl:amount> 958.54 <")
    many = s.replace("<payrollNumber>1<", "<payrollNumber>x<").replace("<gender>Female<", "<gender>Woman<")
    many = many.replace("<laborHourDate>2026-10-05<", "<laborHourDate>10/05/2026<", 1)
    c["x19_many.xml"] = many
    c["x20_comment_in_text.xml"] = s.replace("<lastName>Garcia<", "<lastName>Gar<!-- c -->cia<")
    c["x21_total_hours.xml"] = s.replace("<totalHours>41.00<", "<totalHours>45.00<")
    c["x22_utf16_bom.xml"] = s.replace("encoding='UTF-8'", "encoding='UTF-16'").encode("utf-16")
    c["x23_cp1252_says_utf8.xml"] = s.replace("<lastName>Garcia<", "<lastName>Mu\u00f1oz<").encode("cp1252")
    c["x24_utf8_says_utf16.xml"] = s.replace("encoding='UTF-8'", "encoding='utf-16'")
    c["x25_cut_off.xml"] = s[: len(s) // 2]
    for name, text in c.items():
        assert name == "x01_sample.xml" or text != s, f"{name}: the planted change did not land"
    assert c["x23_cp1252_says_utf8.xml"] != c["x01_sample.xml"].encode("cp1252")
    return c


def python_results(folder: Path):
    out = {}
    for f in sorted(folder.iterdir()):
        if f.suffix == ".csv":
            target = folder / (f.name + ".out")
            try:
                convert.convert(f, target)
                out[f.name] = {"xml": target.read_bytes().decode("utf-8")}
            except convert.ConvertError as e:
                out[f.name] = {"error": str(e)}
        elif f.suffix == ".xml":
            out[f.name] = {"errors": check.rule_errors(f)}
    return out


@needs_node
def test_browser_code_matches_python(tmp_path):
    cases = {**csv_cases(), **xml_cases()}
    for name, text in cases.items():
        (tmp_path / name).write_bytes(text if isinstance(text, bytes) else text.encode("utf-8"))
    py = python_results(tmp_path)
    r = subprocess.run(["node", str(ROOT / "tests/web_parity.js"), str(tmp_path)], capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, r.stderr
    js = json.loads(r.stdout)
    assert sorted(js) == sorted(cases)
    for name in sorted(cases):
        if (py[name].get("errors") or [""])[0].startswith(MALFORMED):
            # The parser writes this message, so the wording differs. Both must refuse the file.
            assert len(py[name]["errors"]) == 1, name
            assert len(js[name]["errors"]) == 1 and js[name]["errors"][0].startswith(MALFORMED), (name, js[name])
            continue
        assert js[name] == py[name], name


@needs_node
def test_excel_habits_still_give_the_validated_file(tmp_path):
    cases = csv_cases()
    for name in ["c13_us_dates.csv", "c14_leading_blank_line.csv", "c15_negative_zero.csv"]:
        (tmp_path / name).write_text(cases[name], encoding="utf-8")
    r = subprocess.run(["node", str(ROOT / "tests/web_parity.js"), str(tmp_path)], capture_output=True, text=True, encoding="utf-8")
    js = json.loads(r.stdout)
    for name in ["c13_us_dates.csv", "c14_leading_blank_line.csv", "c15_negative_zero.csv"]:
        assert js[name]["xml"] == SAMPLE_XML, name


@needs_node
def test_browser_sample_is_the_validated_file(tmp_path):
    (tmp_path / "week1.csv").write_text(SAMPLE_CSV, encoding="utf-8")
    r = subprocess.run(["node", str(ROOT / "tests/web_parity.js"), str(tmp_path)], capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["week1.csv"]["xml"] == SAMPLE_XML


def test_page_sample_matches_repo_sample():
    js = (ROOT / "docs/prlxml.js").read_text(encoding="utf-8")
    for line in SAMPLE_CSV.strip("\n").split("\n"):
        assert f'"{line}"' in js


CLEAN_XML = {"x01_sample.xml", "x18_padded_text.xml", "x20_comment_in_text.xml", "x22_utf16_bom.xml"}


def test_python_catches_every_planted_error(tmp_path):
    """Runs without Node. Every planted XML error is reported, every bad CSV is refused, every good CSV converts clean."""
    for name, text in xml_cases().items():
        f = tmp_path / name
        f.write_bytes(text if isinstance(text, bytes) else text.encode("utf-8"))
        errs = check.rule_errors(f)
        assert bool(errs) == (name not in CLEAN_XML), (name, errs)
    for name, text in csv_cases().items():
        f = tmp_path / name
        f.write_bytes(text if isinstance(text, bytes) else text.encode("utf-8"))
        out = tmp_path / (name + ".out")
        if name.startswith("e"):
            with pytest.raises(convert.ConvertError):
                convert.convert(f, out)
        else:
            convert.convert(f, out)
            assert check.rule_errors(out) == [], name
