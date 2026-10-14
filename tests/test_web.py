"""The browser page (docs/prlxml.js) must give the same answers as the Python tool.

Writes a set of CSV and XML cases, runs the Python convert and check on each,
runs docs/prlxml.js on the same files under Node (tests/web_parity.js), and
compares. Converted XML must match byte for byte. Error and warning messages
must match word for word.

Case names: c converts clean, e is refused by convert, k converts but the check
finds rule errors, x has rule errors, w has warnings and no rule errors.

Needs node and @xmldom/xmldom on NODE_PATH. Skips without them, unless
REQUIRE_WEB_TESTS=1 is set (CI sets it).
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from lxml import etree

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


def _with(cols, garcia, nguyen):
    """The sample with optional columns added. garcia and nguyen are the values for each person's rows."""
    head = HEADER + "," + ",".join(cols)
    return _csv([head] + [d + "," + ",".join(garcia) for d in DATA[:5]] + [d + "," + ",".join(nguyen) for d in DATA[5:]])


PROGRAMS = [
    "Laborers Health Fund | 55-1234 | Ann Lee | 608-555-0100",
    "Laborers Pension Fund | 55-9876 | Ann Lee | 608-555-0100",
    "Laborers Annuity | A-77 | Bob Ray | 608-555-0199 | 201",
]


def _plan_funds():
    """Plan Funds: three programs, rates per line, and the fringe paid. Garcia works 41 hours, Nguyen 40."""
    rows = [_swap(d, "fringe_type", "Plan Funds") for d in DATA]
    cols = ["health_rate", "pension_rate", "other1_rate", "fringe_benefits", "health_program", "pension_program", "other1_program"]
    garcia = ["8.10", "6.25", "", "588.35"] + PROGRAMS
    nguyen = ["8.10", "6.25", "1.00", "614.00"] + PROGRAMS
    return _csv([HEADER + "," + ",".join(cols)] + [d + "," + ",".join(garcia) for d in rows[:5]] + [d + "," + ",".join(nguyen) for d in rows[5:]])


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
    mixed = [_swap(_swap(d, "gender", "m"), "apprentice", "Yes") + ",A-77,60" for d in DATA[:5]]
    mixed += [_swap(d, "gender", "F") + ",," for d in DATA[5:]]
    c["c06_gender_apprentice.csv"] = _csv([HEADER + ",apprentice_id,apprentice_pct"] + mixed)
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
    opt = ["project_gross", "lump_sum", "apprentice_id", "apprentice_pct"]
    c["c17_optional_columns.csv"] = _with(opt, ["", "57.00", "", ""], ["1364.00", "", "", ""])
    c["c18_fringe_lowercase.csv"] = _csv([HEADER] + [_swap(d, "fringe_type", "cash") for d in DATA])
    c["c19_apprentice_id_ignored_when_not_apprentice.csv"] = _with(["apprentice_id", "apprentice_pct"], ["A-77", "60"], ["", ""])
    c["e14_bad_project_gross.csv"] = _with(["project_gross"], ["abc"], [""])
    gross_rows = [d + ",1239.75" for d in DATA[:4]] + [DATA[4] + ",1240.00"] + [d + "," for d in DATA[5:]]
    c["e15_project_gross_differs.csv"] = _csv([HEADER + ",project_gross"] + gross_rows)
    c["k01_apprentice_without_id.csv"] = _csv([HEADER] + [_swap(d, "apprentice", "Y") for d in DATA[:5]] + DATA[5:])
    c["k02_fringe_typo.csv"] = _csv([HEADER] + [_swap(d, "fringe_type", "Cash fringe") for d in DATA])
    c["k03_long_cell.csv"] = _csv([HEADER] + [_swap(d, "last_name", "G" * 140000) for d in DATA[:5]] + DATA[5:])
    c["c20_rate_decimals.csv"] = _csv([HEADER] + [_swap(_swap(d, "st_rate", "28.505"), "ot_rate", "42.7575") for d in DATA[:5]] + DATA[5:])
    c["c21_rate_more_places_than_allowed.csv"] = _csv([HEADER] + [_swap(_swap(d, "st_rate", "28.50049"), "ot_rate", "42.757549") for d in DATA[:5]] + DATA[5:])
    c["e16_huge_number.csv"] = _csv([HEADER] + [_swap(d, "gross_pay", "1E+300") for d in DATA[:5]] + DATA[5:])
    c["c22_plan_funds.csv"] = _plan_funds()
    c["c23_fringe_rate_zero_left_out.csv"] = _with(["health_rate", "fringe_benefits"], ["0", ""], ["0.00", "0"])
    c["e18_fringe_rate_three_decimals.csv"] = _with(["health_rate"], ["8.125"], [""])
    c["e19_program_missing_a_part.csv"] = _with(["health_program"], ["Health fund | 55-1234 | Ann Lee"], ["Health fund | 55-1234 | Ann Lee"])
    c["e20_program_differs.csv"] = _with(["health_program"], [PROGRAMS[0]], ["Other fund | 55-1234 | Ann Lee | 608-555-0100"])
    c["e17_rate_differs_past_cents.csv"] = _csv([HEADER] + [_swap(d, "st_rate", "28.505") for d in DATA[:4]] + [_swap(DATA[4], "st_rate", "28.506")] + DATA[5:])
    # A decimal comma must stop the run: 8,0 read as 80 hours would pass the schema and most rules.
    c["e21_decimal_comma_hours.csv"] = _csv([HEADER] + DATA[:4] + [_swap(DATA[4], "ot_hours", '"1,5"')] + DATA[5:])
    c["e22_comma_not_in_threes.csv"] = _csv([HEADER] + [_swap(d, "gross_pay", '"1,23,9.75"') for d in DATA[:5]] + DATA[5:])
    return c


P = "{http://www.transxml.net/schema/prl/1.2}"
T = "{http://www.transxml.net/schema/txl/1.0}"


def _mutate(fn):
    root = etree.fromstring(SAMPLE_XML.encode("utf-8"))
    fn(root)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8").decode("utf-8")


def _emp(root, i):
    return root.findall(f"{P}PayrollEmployees/{P}PayrollEmployee")[i]


def _lab(root, i):
    return _emp(root, i).find(f"{P}PayrollEmployeeLabors/{P}PayrollEmployeeLabor")


def _day(root, i, n):
    return _lab(root, i).findall(f"{P}PayrollEmployeeLaborHours/{P}PayrollEmployeeLaborHour")[n]


def _amt(node, tag):
    return node.find(f"{P}{tag}/{T}Currency/{T}amount")


def _set(node, path, text):
    e = node.find(path)
    assert e is not None, path
    e.text = text


def _drop(node, tag):
    e = node.find(f"{P}{tag}")
    assert e is not None, tag
    node.remove(e)


def _new(tag, text=None, kids=()):
    e = etree.Element(f"{P}{tag}")
    if text is not None:
        e.text = text
    for k in kids:
        e.append(k)
    return e


def _money(tag, amount):
    wrap = _new(tag)
    cur = etree.SubElement(wrap, f"{T}Currency")
    etree.SubElement(cur, f"{T}amount").text = amount
    return wrap


def _after(node, tag, new):
    ref = node.find(f"{P}{tag}")
    assert ref is not None, tag
    ref.addnext(new)


def _program(ptype, name="Health plan", cls=None):
    kids = [_new("benefitProgramName", name), _new("benefitAccountID", "A1"), _new("trusteeContactPerson", "Pat Lee"),
            _new("trusteeContactPhoneNumber", "5125550100"), _new("benefitProgramType", ptype)]
    if cls:
        kids.append(_new("benefitProgramClass", cls))
    return _new("PayrollBenefitProgram", kids=kids)


def _programs(*progs):
    return lambda r: _after(r, "fringeBenefitPaymentType", _new("PayrollBenefitPrograms", kids=list(progs)))


def _seq(*fns):
    def run(r):
        for f in fns:
            f(r)
    return run


def _salaried(r):
    emp, lab = _emp(r, 0), _lab(r, 0)
    _after(emp, "changeIndicator", _new("salariedEmployeeIndicator", "true"))
    _drop(lab, "straightTimeHourlyRate")
    _drop(lab, "overtimeHourlyRate")
    _set(lab, f"{P}totalHours", "40.00")
    for n in range(5):
        day = _day(r, 0, n)
        day.replace(day.find(f"{P}hourlyHours"), _new("salariedEmployeeHours", "8.00"))


def _no_tax(r):
    for tag in ("fICAAmount", "federalWithholdingTaxAmount", "stateWithholdingTaxAmount", "medicareAmount"):
        _drop(_lab(r, 0), tag)


def _drop_zero_ot(r):
    for n in range(5):
        hh = _day(r, 0, n).find(f"{P}hourlyHours")
        if hh.find(f"{P}overtimeHours").text == "0.00":
            hh.remove(hh.find(f"{P}overtimeHours"))


def _time_zones(r):
    _set(r, f"{P}payrollBeginDate", "2026-10-04-05:00")
    _set(r, f"{P}payrollEndDate", "2026-10-10-05:00")
    for n in range(5):
        _set(_day(r, 0, n), f"{P}laborHourDate", _day(r, 0, n).find(f"{P}laborHourDate").text + "Z")


def tree_cases():
    """Planted changes made on the parsed sample. x: rule errors (or clean, see CLEAN_XML). w: warnings and no rule errors."""
    ruiz = _new("PayrollEmployee", kids=[_new("lastName", "Ruiz"), _new("firstName", "Ana"), _new("middleInitial", ""),
                                         _new("PartialSsn", "9012"), _new("gender", "Female"), _new("ethnicity", "HISP"), _new("changeIndicator", "true")])
    spec = {
        "x26_fringe_type_lowercase.xml": lambda r: _set(r, f"{P}fringeBenefitPaymentType", "cash"),
        "x27_no_straight_rate.xml": lambda r: _drop(_lab(r, 0), "straightTimeHourlyRate"),
        "x28_zero_rate.xml": lambda r: setattr(_amt(_lab(r, 0), "straightTimeHourlyRate"), "text", "0.00"),
        "x29_apprentice_no_id.xml": lambda r: _set(_lab(r, 0), f"{P}apprentice", "true"),
        "x30_ojt_no_percentage.xml": lambda r: _set(_lab(r, 0), f"{P}ojtProgramIndicator", "true"),
        "x31_negative_hours.xml": _seq(lambda r: _set(_day(r, 0, 0), f"{P}hourlyHours/{P}overtimeHours", "-1.00"),
                                       lambda r: _set(_day(r, 0, 2), f"{P}hourlyHours/{P}overtimeHours", "2.00")),
        "x32_no_project_gross.xml": lambda r: _drop(_lab(r, 0), "grossProjectAmountEarned"),
        "x33_no_employee_id.xml": _seq(lambda r: _drop(_emp(r, 0), "PartialSsn"), lambda r: _drop(_emp(r, 0), "vendorSuppliedEmployeeID")),
        "x34_deduction_twice.xml": lambda r: _lab(r, 0).find(f"{P}PayrollEmployeeOtherDeductions").append(
            _new("PayrollEmployeeOtherDeduction", kids=[_new("description", "Union dues"), _money("amount", "0.00")])),
        "x35_salaried_with_rates.xml": lambda r: _after(_emp(r, 0), "changeIndicator", _new("salariedEmployeeIndicator", "true")),
        "x36_program_bad_type.xml": _programs(_program("Health")),
        "x37_fringe_rate_zero.xml": lambda r: _after(_lab(r, 0), "overtimeHourlyRate", _money("healthWellfareRate", "0.00")),
        "x38_no_total_hours.xml": lambda r: _drop(_lab(r, 0), "totalHours"),
        "x39_salaried_hours_for_hourly.xml": lambda r: _day(r, 0, 0).replace(_day(r, 0, 0).find(f"{P}hourlyHours"), _new("salariedEmployeeHours", "8.00")),
        "x40_long_comment.xml": lambda r: _after(r, "fringeBenefitPaymentType", _new("comments", "x" * 257)),
        "x41_program_other_no_class.xml": _programs(_program("Fringe Other 1")),
        "x42_two_programs_same_name.xml": _programs(_program("Fringe Pension"), _program("Fringe Health/Welfare")),
        "w01_duplicate_day.xml": lambda r: _set(_day(r, 0, 1), f"{P}laborHourDate", "2026-10-05"),
        "w02_deductions_do_not_add_up.xml": lambda r: setattr(_amt(_lab(r, 1).find(f"{P}PayrollEmployeeOtherDeductions/{P}PayrollEmployeeOtherDeduction"), "amount"), "text", "40.00"),
        "w03_underpaid_on_project.xml": lambda r: setattr(_amt(_lab(r, 1), "grossProjectAmountEarned"), "text", "400.00"),
        "w04_gross_below_project.xml": lambda r: setattr(_amt(_lab(r, 0), "grossProjectAmountEarned"), "text", "1300.00"),
        "w05_overtime_rate_low.xml": lambda r: setattr(_amt(_lab(r, 0), "overtimeHourlyRate"), "text", "20.00"),
        "w06_zero_hours_employee.xml": lambda r: r.find(f"{P}PayrollEmployees").append(ruiz),
        "w07_same_name_twice.xml": _seq(lambda r: _set(_emp(r, 1), f"{P}lastName", "Garcia"), lambda r: _set(_emp(r, 1), f"{P}firstName", "Luis")),
        "w08_plan_funds_no_rates.xml": lambda r: _set(r, f"{P}fringeBenefitPaymentType", "Plan Funds"),
        "w09_exceptions_none.xml": lambda r: _set(r, f"{P}fringeBenefitPaymentType", "Plan Funds with Exceptions"),
        "w10_long_day.xml": _seq(lambda r: _set(_day(r, 0, 0), f"{P}hourlyHours/{P}straightTimeHours", "24.00"),
                                 lambda r: _set(_day(r, 0, 1), f"{P}hourlyHours/{P}straightTimeHours", "0.00"),
                                 lambda r: _set(_day(r, 0, 2), f"{P}hourlyHours/{P}straightTimeHours", "0.00"),
                                 lambda r: _set(_day(r, 0, 2), f"{P}laborHourDate", "2026-10-05")),
        "w11_grosspay_underpaid.xml": _seq(lambda r: setattr(_amt(_lab(r, 1), "grossPay"), "text", "1000.00"),
                                           lambda r: setattr(_amt(_lab(r, 1), "netPay"), "text", "687.56")),
        "w12_no_daily_overtime.xml": _drop_zero_ot,
        "w13_overtime_rate_zero_no_overtime.xml": lambda r: setattr(_amt(_lab(r, 1), "overtimeHourlyRate"), "text", "0.00"),
        "x45_overtime_rate_zero_with_overtime.xml": lambda r: setattr(_amt(_lab(r, 0), "overtimeHourlyRate"), "text", "0.00"),
        "x46_no_tax_fields.xml": _no_tax,
        "x47_dates_with_time_zone.xml": _time_zones,
        "x48_salaried_employee.xml": _salaried,
        "x49_huge_rate.xml": lambda r: setattr(_amt(_lab(r, 0), "straightTimeHourlyRate"), "text", "1E+300"),
        "x50_fullwidth_payroll_number.xml": lambda r: _set(r, f"{P}payrollNumber", "\uff11"),
    }
    return {name: _mutate(fn) for name, fn in spec.items()}


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
    c["x43_cut_off_third.xml"] = s[: len(s) // 3]
    c["x44_cut_off_end.xml"] = s[: len(s) - 12]
    c.update(tree_cases())
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
            errs, warns = check.scan(f)
            out[f.name] = {"errors": errs, "warnings": warns}
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
def test_browser_sample_is_the_repo_sample(tmp_path):
    (tmp_path / "week1.csv").write_text(SAMPLE_CSV, encoding="utf-8")
    r = subprocess.run(["node", str(ROOT / "tests/web_parity.js"), str(tmp_path)], capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["week1.csv"]["xml"] == SAMPLE_XML


def test_page_sample_matches_repo_sample():
    js = (ROOT / "docs/prlxml.js").read_text(encoding="utf-8")
    for line in SAMPLE_CSV.strip("\n").split("\n"):
        assert f'"{line}"' in js


CLEAN_XML = {"x01_sample.xml", "x18_padded_text.xml", "x20_comment_in_text.xml", "x22_utf16_bom.xml",
             "x46_no_tax_fields.xml", "x47_dates_with_time_zone.xml", "x48_salaried_employee.xml"}


def test_python_catches_every_planted_error(tmp_path):
    """Runs without Node. Every planted XML error and warning is reported, every bad CSV is refused, every good CSV converts clean."""
    for name, text in xml_cases().items():
        f = tmp_path / name
        f.write_bytes(text if isinstance(text, bytes) else text.encode("utf-8"))
        errs, warns = check.scan(f)
        if name.startswith("w"):
            assert errs == [] and warns, (name, errs, warns)
        else:
            assert bool(errs) == (name not in CLEAN_XML), (name, errs)
        if name in CLEAN_XML:
            assert warns == [], (name, warns)
    for name, text in csv_cases().items():
        f = tmp_path / name
        f.write_bytes(text if isinstance(text, bytes) else text.encode("utf-8"))
        out = tmp_path / (name + ".out")
        if name.startswith("e"):
            with pytest.raises(convert.ConvertError):
                convert.convert(f, out)
        else:
            convert.convert(f, out)
            assert bool(check.rule_errors(out)) == name.startswith("k"), (name, check.rule_errors(out))


def test_each_new_rule_says_what_it_found(tmp_path):
    """The planted change is the thing reported, not some other rule tripping by chance."""
    want = {
        "x26_fringe_type_lowercase.xml": "fringeBenefitPaymentType must be Cash, Plan Funds, or Plan Funds with Exceptions, got 'cash'",
        "x27_no_straight_rate.xml": "Garcia, Luis 101: straightTimeHourlyRate is required for an hourly employee",
        "x28_zero_rate.xml": "Garcia, Luis 101: straightTimeHourlyRate must be more than 0, got 0.00",
        "x29_apprentice_no_id.xml": "Garcia, Luis 101: apprenticeID is required when apprentice is true",
        "x30_ojt_no_percentage.xml": "Garcia, Luis 101: ojtWagePercentage is required when ojtProgramIndicator is true",
        "x31_negative_hours.xml": "Garcia, Luis 101 2026-10-05: hours cannot be below 0",
        "x32_no_project_gross.xml": "Garcia, Luis 101: grossProjectAmountEarned is required, the pay for this contract and project only",
        "x33_no_employee_id.xml": "Garcia, Luis: no employee ID; give socialSecurityNumber, PartialSsn or vendorSuppliedEmployeeID, whichever your state asks for",
        "x34_deduction_twice.xml": "Garcia, Luis 101: other deduction 'Union dues' is listed twice; each description must be unique",
        "x35_salaried_with_rates.xml": "Garcia, Luis 101: a salaried employee has no straightTimeHourlyRate or overtimeHourlyRate; take them out",
        "x36_program_bad_type.xml": "benefit program 1: benefitProgramType must be one of Fringe Health/Welfare, Fringe Vacation/Holiday, Fringe Apprenticeship Fund, Fringe Pension, Fringe Other 1, Fringe Other 2, got 'Health'",
        "x37_fringe_rate_zero.xml": "Garcia, Luis 101: healthWellfareRate must be more than 0 when it is in the file, got 0.00",
        "x38_no_total_hours.xml": "Garcia, Luis 101: totalHours is required",
        "x39_salaried_hours_for_hourly.xml": "Garcia, Luis 101 2026-10-05: salariedEmployeeHours is only for a salaried employee; use straightTimeHours and overtimeHours",
        "x40_long_comment.xml": "comments is 257 characters, the limit is 256",
        "x41_program_other_no_class.xml": "benefit program 1: benefitProgramClass is required for Fringe Other 1",
        "x42_two_programs_same_name.xml": "benefit program 2: benefitProgramName 'Health plan' is used twice; each program needs its own name",
        "w01_duplicate_day.xml": "Garcia, Luis 101: 2026-10-05 is listed twice; merge it into one day",
        "w02_deductions_do_not_add_up.xml": "Nguyen, Tran 201: FICA, federal, state, Medicare and other deductions add up to 304.35, but totalDeductions is 312.44; totalDeductions should include all taxes and other deductions",
        "w03_underpaid_on_project.xml": "Nguyen, Tran 201: grossProjectAmountEarned 400.00 is less than the hours times the rates (1364.00); that reads as underpayment",
        "w04_gross_below_project.xml": "Garcia, Luis 101: grossPay 1239.75 is less than grossProjectAmountEarned 1300.00; gross pay should be the project pay plus any other pay",
        "w05_overtime_rate_low.xml": "Garcia, Luis 101: overtime rate 20.00 is lower than the straight rate 28.50",
        "w06_zero_hours_employee.xml": "Ruiz, Ana: no hours on this payroll; a state that sets Include Employees with Zero Hours to False rejects the file",
        "w07_same_name_twice.xml": "Garcia, Luis: listed as 2 separate employees; if this is one person, put all of their labor lines under one employee",
        "w08_plan_funds_no_rates.xml": "Garcia, Luis 101: fringe type is Plan Funds but this line has no fringe rate; fill at least one fringe rate and fringeBenefits",
        "w09_exceptions_none.xml": "fringe type is Plan Funds with Exceptions, but no employee has a fringe benefit exception",
        "w10_long_day.xml": "Garcia, Luis: 2026-10-05 adds up to 25.00 hours, more than a day holds",
        "w11_grosspay_underpaid.xml": "Nguyen, Tran 201: grossPay 1000.00 is less than the hours times the rates (1364.00); that reads as underpayment",
        "w12_no_daily_overtime.xml": "Garcia, Luis 101 2026-10-05: overtimeHours is left out; Wisconsin's import wants 0.00 on a day with no overtime",
        "w13_overtime_rate_zero_no_overtime.xml": "Nguyen, Tran 201: overtimeHourlyRate is 0.00; some states want a rate above 0 even with no overtime",
        "x45_overtime_rate_zero_with_overtime.xml": "Garcia, Luis 101: overtimeHourlyRate must be more than 0 when there is overtime, got 0.00",
        "x49_huge_rate.xml": "Garcia, Luis 101: straightTimeHourlyRate '1E+300' is not a number",
        "x50_fullwidth_payroll_number.xml": "payrollNumber must be a whole number starting at 1, got '\uff11'",
    }
    cases = {k: v for k, v in tree_cases().items() if k not in CLEAN_XML}
    assert sorted(want) == sorted(cases)
    for name, line in want.items():
        f = tmp_path / name
        f.write_text(cases[name], encoding="utf-8")
        errs, warns = check.scan(f)
        assert line in (warns if name.startswith("w") else errs), (name, errs, warns)


def test_rates_keep_their_decimals(tmp_path):
    """The field definitions allow 3 places on the straight time rate and 4 on overtime. Rounding them to cents changed the pay."""
    cases = csv_cases()
    f = tmp_path / "c20.csv"
    f.write_text(cases["c20_rate_decimals.csv"], encoding="utf-8")
    out = tmp_path / "c20.xml"
    convert.convert(f, out)
    xml = out.read_text(encoding="utf-8")
    assert "<txl:amount>28.505</txl:amount>" in xml and "<txl:amount>42.7575</txl:amount>" in xml
    assert "<txl:amount>1182.96</txl:amount>" in xml  # 28.505 x 40 + 42.7575 x 1 = 1182.9575
    f.write_text(cases["c21_rate_more_places_than_allowed.csv"], encoding="utf-8")
    convert.convert(f, out)
    xml = out.read_text(encoding="utf-8")
    assert "<txl:amount>28.500</txl:amount>" in xml and "<txl:amount>42.7575</txl:amount>" in xml


def test_sample_has_no_warnings():
    errs, warns = check.scan(ROOT / "samples/week1.xml")
    assert errs == [] and warns == []


def test_plan_funds_programs_and_rates(tmp_path):
    """Fringe programs go at the top, one per type; rates and the fringe paid go on each labor line. The file passes the schema and the rules."""
    f = tmp_path / "c22.csv"
    f.write_text(csv_cases()["c22_plan_funds.csv"], encoding="utf-8")
    out = tmp_path / "c22.xml"
    convert.convert(f, out)
    root = etree.parse(str(out)).getroot()
    progs = root.findall(f"{P}PayrollBenefitPrograms/{P}PayrollBenefitProgram")
    assert [p.findtext(f"{P}benefitProgramType") for p in progs] == ["Fringe Health/Welfare", "Fringe Pension", "Fringe Other 1"]
    assert [p.findtext(f"{P}benefitProgramClass") for p in progs] == [None, None, "201"]
    assert progs[0].findtext(f"{P}trusteeContactPhoneNumber") == "608-555-0100"
    garcia, nguyen = _lab(root, 0), _lab(root, 1)
    assert _amt(garcia, "healthWellfareRate").text == "8.10" and _amt(garcia, "pensionRate").text == "6.25"
    assert garcia.find(f"{P}other1Rate") is None and _amt(nguyen, "other1Rate").text == "1.00"
    assert _amt(garcia, "fringeBenefits").text == "588.35" and _amt(nguyen, "fringeBenefits").text == "614.00"
    r = subprocess.run([sys.executable, "-m", "prlxml.check", str(out), "--schemas", str(ROOT / "schemas")], cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    errs, warns = check.scan(out)
    assert errs == [] and warns == [], (errs, warns)


def test_fringe_inputs_that_stop_convert(tmp_path):
    cases = csv_cases()
    want = {
        "e21_decimal_comma_hours.csv": "row 6: ot_hours is not a number: '1,5'. A comma only marks thousands, like 1,239.75. Write a decimal with a dot.",
        "e22_comma_not_in_threes.csv": "row 2: gross_pay is not a number: '1,23,9.75'. A comma only marks thousands",
        "e18_fringe_rate_three_decimals.csv": "row 2: health_rate has more than 2 decimals: '8.125'",
        "e19_program_missing_a_part.csv": "row 2: health_program needs name | account ID | trustee | phone",
        "e20_program_differs.csv": "column health_program must be the same on every row",
    }
    for name, start in want.items():
        f = tmp_path / name
        f.write_text(cases[name], encoding="utf-8")
        try:
            convert.convert(f, tmp_path / "x.xml")
        except convert.ConvertError as e:
            assert str(e).startswith(start), (name, str(e))
        else:
            raise AssertionError(name + " converted")


def test_zero_fringe_rate_is_left_out(tmp_path):
    f = tmp_path / "c23.csv"
    f.write_text(csv_cases()["c23_fringe_rate_zero_left_out.csv"], encoding="utf-8")
    convert.convert(f, tmp_path / "c23.xml")
    xml = (tmp_path / "c23.xml").read_text(encoding="utf-8")
    assert "healthWellfareRate" not in xml and "PayrollBenefitPrograms" not in xml
    assert "<fringeBenefits>" in xml  # Nguyen's 0 fringe paid is written as typed
