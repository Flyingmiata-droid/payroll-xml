"""Convert a flat CSV of certified payroll rows into Payroll XML 1.2."""
import argparse
import csv
import io
import re
import sys
from collections import OrderedDict
from decimal import ROUND_HALF_EVEN, Decimal, localcontext
from pathlib import Path

from lxml import etree

from . import PRL_NS, TXL_NS

NSMAP = {None: PRL_NS, "txl": TXL_NS}

HEADER_COLS = ["vendor_id", "contract_id", "payroll_number", "period_begin", "period_end", "fringe_type"]
EMP_COLS = ["last_name", "first_name", "middle_initial", "ssn", "employee_id", "gender", "ethnicity"]
LABOR_COLS = ["craft_code", "labor_class", "project_id", "apprentice", "st_rate", "ot_rate"]
DAY_COLS = ["work_date", "st_hours", "ot_hours"]
TOTAL_COLS = ["gross_pay", "total_deductions", "net_pay", "fica", "federal_tax", "state_tax", "medicare", "other_deductions"]
REQUIRED = HEADER_COLS + EMP_COLS + LABOR_COLS + DAY_COLS + TOTAL_COLS
# Optional columns. Leave them out or blank when they do not apply.
# project_gross: pay for this contract and project only. Blank means rates times hours plus lump_sum.
# lump_sum: cash fringe or other cash paid on this line. apprentice_id, apprentice_pct: needed when apprentice is yes.
OPTIONAL = ["project_gross", "lump_sum", "apprentice_id", "apprentice_pct"]
DATE_COLS = ["period_begin", "period_end", "work_date"]
SAME_FOR_EMPLOYEE = ["middle_initial", "gender", "ethnicity"]
SAME_FOR_LABOR = ["apprentice", "st_rate", "ot_rate", "gross_pay", "total_deductions", "net_pay", "fica", "federal_tax", "state_tax", "medicare", "other_deductions"] + OPTIONAL
NUMBER_COLS = {"st_rate", "ot_rate", "gross_pay", "total_deductions", "net_pay", "fica", "federal_tax", "state_tax", "medicare", "project_gross", "lump_sum", "apprentice_pct"}

ENCODING_HELP = "Cannot tell this file's text encoding, so accented names could come out wrong. In Excel, save it again with File, Save As, CSV UTF-8."
_BAD_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")
_US_DATE = re.compile(r"([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})")
# Plain ASCII decimals only, the same numbers docs/prlxml.js accepts.
_NUM = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
# The field definitions allow 3 decimals on the straight time rate and 4 on the overtime rate. Rates keep what was typed, up to that.
RATE_PLACES = {"st_rate": 3, "ot_rate": 4}


class ConvertError(Exception):
    pass


def _parse(value: str, field: str, row_no: int):
    """A Decimal, None for a blank cell. Refuses anything that is not a plain number of sane size."""
    v = (value or "").strip().replace("$", "").replace(",", "")
    if v == "":
        return None
    bad = ConvertError(f"row {row_no}: {field} is not a number: {value!r}")
    if not _NUM.fullmatch(v):
        raise bad
    d = Decimal(v)
    t = d.as_tuple()
    if len(t.digits) > 100 or not -100 <= t.exponent <= 100:
        raise bad
    return d


def _places(d: Decimal, keep: int) -> Decimal:
    with localcontext() as ctx:
        ctx.prec = 1000
        q = d.quantize(Decimal(1).scaleb(-keep), rounding=ROUND_HALF_EVEN)
    return q.copy_abs() if q == 0 else q  # no -0.00, which Excel float leftovers like -1.1E-13 would give


def _dec(value: str, field: str, row_no: int) -> Decimal:
    d = _parse(value, field, row_no)
    return Decimal("0.00") if d is None else _places(d, 2)


def _rate(value: str, field: str, row_no: int) -> Decimal:
    """Keeps the decimals typed: at least 2, at most 3 (straight time) or 4 (overtime)."""
    d = _parse(value, field, row_no)
    if d is None:
        return Decimal("0.00")
    return _places(d, min(max(-d.as_tuple().exponent, 2), RATE_PLACES[field]))


def _bool(value: str) -> str:
    return "true" if (value or "").strip().lower() in ("1", "y", "yes", "true", "t") else "false"


def _gender(value: str) -> str:
    """The system takes the words Male or Female (Payroll XML Project Field Definitions). M and F are mapped; anything else passes through for the checker to flag."""
    v = (value or "").strip()
    return {"m": "Male", "male": "Male", "f": "Female", "female": "Female"}.get(v.lower(), v)


def _fringe(value: str) -> str:
    """The field definitions allow Cash, Plan Funds, or Plan Funds with Exceptions. Case is fixed; anything else passes through for the checker to flag."""
    v = (value or "").strip()
    return {"cash": "Cash", "plan funds": "Plan Funds", "plan funds with exceptions": "Plan Funds with Exceptions"}.get(v.lower(), v)


def _el(parent, tag, text=None):
    e = etree.SubElement(parent, f"{{{PRL_NS}}}{tag}")
    if text is not None:
        e.text = str(text)
    return e


def _currency(parent, tag, amount: Decimal):
    wrap = _el(parent, tag)
    cur = etree.SubElement(wrap, f"{{{TXL_NS}}}Currency")
    places = max(-amount.as_tuple().exponent, 2)
    etree.SubElement(cur, f"{{{TXL_NS}}}amount").text = f"{amount:.{places}f}"
    return wrap


def decode(data: bytes) -> str:
    """UTF-8 (with or without a BOM). Failing that, Excel's plain CSV save, which is Windows-1252. A file mixing the two is refused."""
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    if any(ord(c) > 127 and c != "\ufffd" for c in data.decode("utf-8", errors="replace")):
        raise ConvertError(ENCODING_HELP)
    try:
        return data.decode("cp1252")
    except UnicodeDecodeError as e:
        raise ConvertError(ENCODING_HELP) from e


def _iso(value: str) -> str:
    """Excel saves 2026-10-04 back out as 10/4/2026. Read both."""
    m = _US_DATE.fullmatch(value.strip())
    return f"{m[3]}-{int(m[1]):02d}-{int(m[2]):02d}" if m else value


def read_rows(path: Path):
    text = decode(Path(path).read_bytes())
    csv.field_size_limit(max(csv.field_size_limit(), len(text) + 1))  # a long cell is the checker's business, not a crash
    text = re.sub(r"\A(?:\r\n|\r|\n)+", "", text)
    reader = csv.DictReader(io.StringIO(text, newline=""))
    if reader.fieldnames:
        reader.fieldnames = [(c or "").strip() for c in reader.fieldnames]
    missing = [c for c in REQUIRED if c not in (reader.fieldnames or [])]
    if missing:
        raise ConvertError("CSV is missing columns: " + ", ".join(missing))
    rows = []
    for n, r in enumerate(reader, start=2):
        row = {k: (v or "") for k, v in r.items() if k is not None}
        # Spreadsheet exports often end with rows of bare commas. Skip them.
        if not any(v.strip() for v in row.values()):
            continue
        for c in OPTIONAL:
            row.setdefault(c, "")
        for c in REQUIRED + OPTIONAL:
            if _BAD_CHARS.search(row[c]):
                raise ConvertError(f"row {n}: {c} holds a control character XML cannot carry: {row[c]!r}")
        for c in DATE_COLS:
            row[c] = _iso(row[c])
        row["_row"] = n
        rows.append(row)
    if not rows:
        raise ConvertError("CSV has no data rows")
    return rows


def build_tree(rows):
    first = rows[0]
    for c in HEADER_COLS:
        vals = {(r[c] or "").strip() for r in rows}
        if len(vals) != 1:
            raise ConvertError(f"column {c} must be the same on every row, found {sorted(vals)}")

    root = etree.Element(f"{{{PRL_NS}}}Payroll", nsmap=NSMAP)
    _el(root, "vendorID", first["vendor_id"].strip())
    _el(root, "contractID", first["contract_id"].strip())
    pn = first["payroll_number"].strip()
    if not re.fullmatch(r"[+-]?[0-9]+", pn):
        raise ConvertError(f"payroll_number must be a whole number, got {pn!r}")
    _el(root, "payrollNumber", int(pn))
    _el(root, "payrollBeginDate", first["period_begin"].strip())
    _el(root, "payrollEndDate", first["period_end"].strip())
    _el(root, "fringeBenefitPaymentType", _fringe(first["fringe_type"]))

    # group: employee -> labor class -> day rows
    employees = OrderedDict()
    for i, r in enumerate(rows, start=2):
        i = r.get("_row", i)
        ekey = (r["last_name"].strip(), r["first_name"].strip(), r["ssn"].strip(), r["employee_id"].strip())
        lkey = (r["craft_code"].strip(), r["labor_class"].strip(), r["project_id"].strip())
        employees.setdefault(ekey, OrderedDict()).setdefault(lkey, []).append((i, r))

    # The XML holds these once per employee or labor line, taken from the first row. A different value on a later row would be lost, so stop.
    def same(col, r, n):
        if col in RATE_PLACES:
            return _rate(r[col], col, n)
        if col in NUMBER_COLS:
            return _dec(r[col], col, n)
        if col == "gender":
            return _gender(r[col])
        if col == "apprentice":
            return _bool(r[col])
        return r[col].strip()

    for labors in employees.values():
        e_n, e_row = next(iter(labors.values()))[0]
        for dayrows in labors.values():
            l_n, l_row = dayrows[0]
            for n, r in dayrows:
                for cols, ref_n, ref, scope in ((SAME_FOR_EMPLOYEE, e_n, e_row, "employee"), (SAME_FOR_LABOR, l_n, l_row, "employee and labor class")):
                    for c in cols:
                        if same(c, r, n) != same(c, ref, ref_n):
                            raise ConvertError(f"row {n}: {c} is {r[c].strip()!r} here but {ref[c].strip()!r} on row {ref_n}. It must be the same on every row for one {scope}.")

    emps_el = _el(root, "PayrollEmployees")
    for ekey, labors in employees.items():
        row0 = next(iter(labors.values()))[0][1]
        emp = _el(emps_el, "PayrollEmployee")
        _el(emp, "lastName", row0["last_name"].strip())
        _el(emp, "firstName", row0["first_name"].strip())
        _el(emp, "middleInitial", row0["middle_initial"].strip())
        ssn = row0["ssn"].strip().replace("-", "").replace(" ", "")
        if ssn:
            if len(ssn) == 4:
                _el(emp, "PartialSsn", ssn)
            else:
                _el(emp, "socialSecurityNumber", ssn)
        if row0["employee_id"].strip():
            _el(emp, "vendorSuppliedEmployeeID", row0["employee_id"].strip())
        _el(emp, "gender", _gender(row0["gender"]))
        _el(emp, "ethnicity", row0["ethnicity"].strip())
        # Required by the importing system even though the schema marks it optional (field definitions, row changeIndicator).
        _el(emp, "changeIndicator", "true")

        labors_el = _el(emp, "PayrollEmployeeLabors")
        for lkey, dayrows in labors.items():
            n0, l0 = dayrows[0]
            lab = _el(labors_el, "PayrollEmployeeLabor")
            _el(lab, "craftCode", l0["craft_code"].strip())
            _el(lab, "laborClass", l0["labor_class"].strip())
            _el(lab, "projectID", l0["project_id"].strip())
            _el(lab, "ojtProgramIndicator", "false")
            st_rate = _rate(l0["st_rate"], "st_rate", n0)
            ot_rate = _rate(l0["ot_rate"], "ot_rate", n0)
            _currency(lab, "straightTimeHourlyRate", st_rate)
            _currency(lab, "overtimeHourlyRate", ot_rate)
            lump = _dec(l0["lump_sum"], "lump_sum", n0)
            if l0["lump_sum"].strip():
                _currency(lab, "lumpSumPayment", lump)
            _el(lab, "apprentice", _bool(l0["apprentice"]))
            if _bool(l0["apprentice"]) == "true":
                if l0["apprentice_id"].strip():
                    _el(lab, "apprenticeID", l0["apprentice_id"].strip())
                if l0["apprentice_pct"].strip():
                    _el(lab, "apprenticeWagePercentage", f"{_dec(l0['apprentice_pct'], 'apprentice_pct', n0):.2f}")

            st_total = Decimal("0.00")
            ot_total = Decimal("0.00")
            days = []
            for n, r in dayrows:
                st = _dec(r["st_hours"], "st_hours", n)
                ot = _dec(r["ot_hours"], "ot_hours", n)
                st_total += st
                ot_total += ot
                days.append((r["work_date"].strip(), st, ot))

            _el(lab, "totalHours", f"{st_total + ot_total:.2f}")
            _el(lab, "straightTimeHours", f"{st_total:.2f}")
            _el(lab, "overtimeHours", f"{ot_total:.2f}")
            _currency(lab, "grossPay", _dec(l0["gross_pay"], "gross_pay", n0))
            _currency(lab, "totalDeductions", _dec(l0["total_deductions"], "total_deductions", n0))
            _currency(lab, "netPay", _dec(l0["net_pay"], "net_pay", n0))
            # Required by the field definitions though the schema marks it optional. The state spreadsheets fill it in too.
            if l0["project_gross"].strip():
                project = _dec(l0["project_gross"], "project_gross", n0)
            else:
                with localcontext() as ctx:
                    ctx.prec = 1000
                    project = _places(st_rate * st_total + ot_rate * ot_total + lump, 2)
            _currency(lab, "grossProjectAmountEarned", project)
            _currency(lab, "fICAAmount", _dec(l0["fica"], "fica", n0))
            _currency(lab, "federalWithholdingTaxAmount", _dec(l0["federal_tax"], "federal_tax", n0))
            _currency(lab, "stateWithholdingTaxAmount", _dec(l0["state_tax"], "state_tax", n0))
            _currency(lab, "medicareAmount", _dec(l0["medicare"], "medicare", n0))

            hours_el = _el(lab, "PayrollEmployeeLaborHours")
            for d, st, ot in days:
                h = _el(hours_el, "PayrollEmployeeLaborHour")
                _el(h, "laborHourDate", d)
                hh = _el(h, "hourlyHours")
                _el(hh, "straightTimeHours", f"{st:.2f}")
                _el(hh, "overtimeHours", f"{ot:.2f}")

            pairs = []
            for pair in (l0["other_deductions"] or "").strip().split(";"):
                pair = pair.strip()
                if not pair:
                    continue
                if ":" not in pair:
                    raise ConvertError(f"row {n0}: other_deductions entry {pair!r} needs description:amount")
                desc, amt = pair.rsplit(":", 1)
                pairs.append((desc.strip(), _dec(amt, "other_deductions", n0)))
            if pairs:
                od_el = _el(lab, "PayrollEmployeeOtherDeductions")
                for desc, amount in pairs:
                    od = _el(od_el, "PayrollEmployeeOtherDeduction")
                    _el(od, "description", desc)
                    _currency(od, "amount", amount)
    return etree.ElementTree(root)


def convert(csv_path: Path, out_path: Path) -> Path:
    try:
        tree = build_tree(read_rows(csv_path))
    except ValueError as e:  # lxml refuses control characters in text
        raise ConvertError(f"a cell holds a character XML cannot carry: {e}") from e
    tree.write(str(out_path), xml_declaration=True, encoding="UTF-8", pretty_print=True)
    return out_path


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Convert a certified payroll CSV to Payroll XML 1.2")
    p.add_argument("csv", type=Path)
    p.add_argument("-o", "--out", type=Path, default=None)
    a = p.parse_args(argv)
    out = a.out or a.csv.with_suffix(".xml")
    try:
        convert(a.csv, out)
    except ConvertError as e:
        print(f"convert failed: {e}", file=sys.stderr)
        return 2
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
