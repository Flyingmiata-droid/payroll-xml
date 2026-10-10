"""Check a Payroll XML file: schema first, then the plain-English import rules."""
import argparse
import re
import sys
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

from lxml import etree

from . import MAIN_XSD, PRL_NS

NS = {"p": PRL_NS}


def schema_errors(xml_path: Path, schema_dir: Path):
    xsd = schema_dir / MAIN_XSD
    if not xsd.exists():
        return [f"schema not found at {xsd}. Run: python -m prlxml.fetch_schemas"]
    schema = etree.XMLSchema(etree.parse(str(xsd)))
    try:
        doc = etree.parse(str(xml_path))
    except (etree.XMLSyntaxError, OSError):
        return []  # rule_errors reports it
    if schema.validate(doc):
        return []
    return [f"line {e.line}: {e.message}" for e in schema.error_log]


def _t(node, tag):
    e = node.find(f"p:{tag}", NS)
    return (e.text or "").strip() if e is not None else ""


_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def _d(s):
    """YYYY-MM-DD only, a real calendar day."""
    if not _DATE.fullmatch(s):
        raise ValueError(s)
    return date.fromisoformat(s)


def _num(s):
    try:
        d = Decimal(s)
    except (InvalidOperation, TypeError):
        return None
    return d if d.is_finite() else None


# Field lengths from the Payroll XML Project Field Definitions (xml.aashtowareproject.org, resource kit 2.1).
# middleInitial (1) has its own rule below, so it is left out here to avoid reporting it twice.
MAX_LEN = {
    "vendorID": 20, "contractID": 20, "lastName": 40, "firstName": 40,
    "vendorSuppliedEmployeeID": 40, "ethnicity": 20, "craftCode": 20, "laborClass": 20, "projectID": 18,
    "PartialSsn": 20, "benefitProgramName": 80, "benefitAccountID": 40, "trusteeContactPerson": 40,
}


def _len_errors(node, who):
    out = []
    for tag, n in MAX_LEN.items():
        for e in node.iterfind(f"p:{tag}", NS):
            v = (e.text or "")
            if len(v) > n:
                out.append(f"{who}{tag} is {len(v)} characters, the limit is {n}")
    return out


def rule_errors(xml_path: Path):
    """Rules copied from public state import pages and the official field definitions. Each one is a thing an import rejects."""
    errs = []
    try:
        doc = etree.parse(str(xml_path))
    except (etree.XMLSyntaxError, OSError) as e:
        return [f"not well-formed XML: {e}"]
    root = doc.getroot()
    if etree.QName(root).localname != "Payroll":
        return ["root element is not Payroll"]
    if etree.QName(root).namespace != PRL_NS:
        return [f"Payroll XML 1.2 needs the namespace {PRL_NS}, this file has {etree.QName(root).namespace or '(none)'}"]
    errs += _len_errors(root, "")

    b, e = _t(root, "payrollBeginDate"), _t(root, "payrollEndDate")
    try:
        begin, end = _d(b), _d(e)
        if (end - begin).days != 6:
            errs.append(f"pay period must be seven days: {begin} to {end} is {(end - begin).days + 1} days")
    except ValueError:
        errs.append(f"bad period date: begin {b!r}, end {e!r}")
        begin = end = None

    pn = _t(root, "payrollNumber")
    if not pn.isdigit() or int(pn) < 1:
        errs.append(f"payrollNumber must be a whole number starting at 1, got {pn!r}")
    if " " in _t(root, "contractID") or "-" in _t(root, "contractID"):
        errs.append("contractID must have no dashes or spaces")

    for emp in root.iterfind(".//p:PayrollEmployee", NS):
        who = f"{_t(emp, 'lastName')}, {_t(emp, 'firstName')}"
        errs += _len_errors(emp, who + ": ")
        g = _t(emp, "gender")
        if g and g not in ("Male", "Female"):
            errs.append(f"{who}: gender must be the word Male or Female, got {g!r}")
        if emp.find("p:changeIndicator", NS) is None:
            errs.append(f"{who}: changeIndicator is missing; the importing system requires true or false")
        mi = _t(emp, "middleInitial")
        if len(mi) > 1:
            errs.append(f"{who}: middleInitial must be one character, got {mi!r}")
        ssn = _t(emp, "socialSecurityNumber")
        if ssn and (not ssn.isdigit() or len(ssn) != 9):
            errs.append(f"{who}: socialSecurityNumber must be 9 digits, no dashes or spaces")
        for lab in emp.iterfind(".//p:PayrollEmployeeLabor", NS):
            cls = _t(lab, "laborClass")
            errs += _len_errors(lab, f"{who} {cls}: ")
            st_sum = ot_sum = Decimal("0")
            for h in lab.iterfind(".//p:PayrollEmployeeLaborHour", NS):
                try:
                    d = _d(_t(h, "laborHourDate"))
                except ValueError:
                    errs.append(f"{who} {cls}: bad laborHourDate {_t(h, 'laborHourDate')!r}")
                    continue
                if begin and not (begin <= d <= end):
                    errs.append(f"{who} {cls}: hours on {d} fall outside the pay period")
                hh = h.find("p:hourlyHours", NS)
                if hh is not None:
                    st = _t(hh, "straightTimeHours")
                    ot = _t(hh, "overtimeHours")
                    if st == "" or ot == "":
                        errs.append(f"{who} {cls} {d}: straight and overtime hours must both be filled, use 0.00")
                    st_n, ot_n = _num(st or "0"), _num(ot or "0")
                    if st_n is None or ot_n is None:
                        errs.append(f"{who} {cls} {d}: hours must be numbers, got {st!r} and {ot!r}")
                        continue
                    st_sum += st_n
                    ot_sum += ot_n
            for tag, val in (("straightTimeHours", st_sum), ("overtimeHours", ot_sum)):
                tot = _t(lab, tag)
                if tot:
                    tv = _num(tot)
                    if tv is None:
                        errs.append(f"{who} {cls}: {tag} total {tot!r} is not a number")
                    elif tv != val:
                        errs.append(f"{who} {cls}: {tag} total {tot} does not match the daily sum {val:.2f}")
            tot = _t(lab, "totalHours")
            if tot:
                tv = _num(tot)
                if tv is None:
                    errs.append(f"{who} {cls}: totalHours {tot!r} is not a number")
                elif tv != st_sum + ot_sum:
                    errs.append(f"{who} {cls}: totalHours {tot} does not match the daily sum {st_sum + ot_sum:.2f}")
            gross = lab.find("p:grossPay/*/*", NS)
            ded = lab.find("p:totalDeductions/*/*", NS)
            net = lab.find("p:netPay/*/*", NS)
            if gross is not None and ded is not None and net is not None:
                g, dd, n = _num(gross.text), _num(ded.text), _num(net.text)
                if g is None or dd is None or n is None:
                    errs.append(f"{who} {cls}: grossPay, totalDeductions and netPay must be numbers")
                elif g - dd != n:
                    errs.append(f"{who} {cls}: grossPay minus totalDeductions is not netPay ({gross.text} - {ded.text} != {net.text})")
    return errs


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Check a Payroll XML file against the schema and the import rules")
    p.add_argument("xml", type=Path)
    p.add_argument("--schemas", type=Path, default=Path("schemas"))
    a = p.parse_args(argv)
    s = schema_errors(a.xml, a.schemas)
    r = rule_errors(a.xml)
    for e in s:
        print(f"SCHEMA  {e}")
    for e in r:
        print(f"RULE    {e}")
    if not s and not r:
        print(f"OK {a.xml}: schema valid, rules clean")
        return 0
    print(f"{len(s)} schema errors, {len(r)} rule errors")
    return 1


if __name__ == "__main__":
    sys.exit(main())
