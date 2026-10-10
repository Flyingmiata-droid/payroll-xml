"""Check a Payroll XML file: schema first, then the plain-English import rules."""
import argparse
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

from lxml import etree

from . import MAIN_XSD, PRL_NS

NS = {"p": PRL_NS}


def schema_errors(xml_path: Path, schema_dir: Path):
    xsd = schema_dir / MAIN_XSD
    if not xsd.exists():
        return [f"schema not found at {xsd}. Run: python -m prlxml.fetch_schemas"]
    schema = etree.XMLSchema(etree.parse(str(xsd)))
    doc = etree.parse(str(xml_path))
    if schema.validate(doc):
        return []
    return [f"line {e.line}: {e.message}" for e in schema.error_log]


def _t(node, tag):
    e = node.find(f"p:{tag}", NS)
    return (e.text or "").strip() if e is not None else ""


def _d(s):
    return date.fromisoformat(s)


# Field lengths from the Payroll XML Project Field Definitions (xml.aashtowareproject.org, resource kit 2.1).
MAX_LEN = {
    "vendorID": 20, "contractID": 20, "lastName": 40, "firstName": 40, "middleInitial": 1,
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
    doc = etree.parse(str(xml_path))
    root = doc.getroot()
    if etree.QName(root).localname != "Payroll":
        return ["root element is not Payroll"]
    errs += _len_errors(root, "")

    try:
        begin, end = _d(_t(root, "payrollBeginDate")), _d(_t(root, "payrollEndDate"))
        if (end - begin).days != 6:
            errs.append(f"pay period must be seven days: {begin} to {end} is {(end - begin).days + 1} days")
    except ValueError as e:
        errs.append(f"bad period date: {e}")
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
                    st_sum += Decimal(st or "0")
                    ot_sum += Decimal(ot or "0")
            for tag, val in (("straightTimeHours", st_sum), ("overtimeHours", ot_sum)):
                tot = _t(lab, tag)
                if tot and Decimal(tot) != val:
                    errs.append(f"{who} {cls}: {tag} total {tot} does not match the daily sum {val:.2f}")
            gross = lab.find("p:grossPay/*/*", NS)
            ded = lab.find("p:totalDeductions/*/*", NS)
            net = lab.find("p:netPay/*/*", NS)
            if gross is not None and ded is not None and net is not None:
                if Decimal(gross.text) - Decimal(ded.text) != Decimal(net.text):
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
