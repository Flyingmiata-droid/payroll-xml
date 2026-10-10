"""Convert a flat CSV of certified payroll rows into Payroll XML 1.2."""
import argparse
import csv
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation
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


class ConvertError(Exception):
    pass


def _dec(value: str, field: str, row_no: int) -> Decimal:
    v = (value or "").strip().replace("$", "").replace(",", "")
    if v == "":
        return Decimal("0.00")
    try:
        return Decimal(v).quantize(Decimal("0.01"))
    except InvalidOperation as e:
        raise ConvertError(f"row {row_no}: {field} is not a number: {value!r}") from e


def _bool(value: str) -> str:
    return "true" if (value or "").strip().lower() in ("1", "y", "yes", "true", "t") else "false"


def _el(parent, tag, text=None):
    e = etree.SubElement(parent, f"{{{PRL_NS}}}{tag}")
    if text is not None:
        e.text = str(text)
    return e


def _currency(parent, tag, amount: Decimal):
    wrap = _el(parent, tag)
    cur = etree.SubElement(wrap, f"{{{TXL_NS}}}Currency")
    etree.SubElement(cur, f"{{{TXL_NS}}}amount").text = f"{amount:.2f}"
    return wrap


def read_rows(path: Path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        missing = [c for c in REQUIRED if c not in (reader.fieldnames or [])]
        if missing:
            raise ConvertError("CSV is missing columns: " + ", ".join(missing))
        rows = [dict(r) for r in reader]
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
    _el(root, "payrollNumber", int(first["payroll_number"].strip()))
    _el(root, "payrollBeginDate", first["period_begin"].strip())
    _el(root, "payrollEndDate", first["period_end"].strip())
    _el(root, "fringeBenefitPaymentType", first["fringe_type"].strip())

    # group: employee -> labor class -> day rows
    employees = OrderedDict()
    for i, r in enumerate(rows, start=2):
        ekey = (r["last_name"].strip(), r["first_name"].strip(), r["ssn"].strip(), r["employee_id"].strip())
        lkey = (r["craft_code"].strip(), r["labor_class"].strip(), r["project_id"].strip())
        employees.setdefault(ekey, OrderedDict()).setdefault(lkey, []).append((i, r))

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
        _el(emp, "gender", row0["gender"].strip())
        _el(emp, "ethnicity", row0["ethnicity"].strip())

        labors_el = _el(emp, "PayrollEmployeeLabors")
        for lkey, dayrows in labors.items():
            n0, l0 = dayrows[0]
            lab = _el(labors_el, "PayrollEmployeeLabor")
            _el(lab, "craftCode", l0["craft_code"].strip())
            _el(lab, "laborClass", l0["labor_class"].strip())
            _el(lab, "projectID", l0["project_id"].strip())
            _el(lab, "ojtProgramIndicator", "false")
            _currency(lab, "straightTimeHourlyRate", _dec(l0["st_rate"], "st_rate", n0))
            _currency(lab, "overtimeHourlyRate", _dec(l0["ot_rate"], "ot_rate", n0))
            _el(lab, "apprentice", _bool(l0["apprentice"]))

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

            other = (l0["other_deductions"] or "").strip()
            if other:
                od_el = _el(lab, "PayrollEmployeeOtherDeductions")
                for pair in other.split(";"):
                    pair = pair.strip()
                    if not pair:
                        continue
                    if ":" not in pair:
                        raise ConvertError(f"row {n0}: other_deductions entry {pair!r} needs description:amount")
                    desc, amt = pair.rsplit(":", 1)
                    od = _el(od_el, "PayrollEmployeeOtherDeduction")
                    _el(od, "description", desc.strip())
                    _currency(od, "amount", _dec(amt, "other_deductions", n0))
    return etree.ElementTree(root)


def convert(csv_path: Path, out_path: Path) -> Path:
    tree = build_tree(read_rows(csv_path))
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
