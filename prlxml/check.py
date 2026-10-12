"""Check a Payroll XML file: schema first, then the plain-English import rules, then warnings.

Rules come from the official Payroll XML Project Field Definitions (AASHTO resource kit 2.1)
and from state import pages. A rule error is something the definitions require or an import
rejects. A warning is something a state reviewer would question, or that some states reject
depending on how they set their agency options.
"""
import argparse
import re
import sys
from collections import OrderedDict
from datetime import date
from decimal import ROUND_HALF_EVEN, Decimal, localcontext
from pathlib import Path

from lxml import etree

from . import MAIN_XSD, PRL_NS, expand_globs

NS = {"p": PRL_NS}

FRINGE_TYPES = ("Cash", "Plan Funds", "Plan Funds with Exceptions")
PLAN_FUNDS = ("Plan Funds", "Plan Funds with Exceptions")
PROGRAM_TYPES = ("Fringe Health/Welfare", "Fringe Vacation/Holiday", "Fringe Apprenticeship Fund", "Fringe Pension", "Fringe Other 1", "Fringe Other 2")
FRINGE_RATES = ("healthWellfareRate", "vacationHolidayRate", "apprenticeshipFundRate", "pensionRate", "other1Rate", "other2Rate")
DEDUCTION_PARTS = ("fICAAmount", "federalWithholdingTaxAmount", "stateWithholdingTaxAmount", "medicareAmount")
TRUE = ("true", "1")
CENT = Decimal("0.01")


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


def _cur(node, tag):
    """The amount inside a currency field. None when the field is absent, "" when it holds no amount."""
    if node.find(f"p:{tag}", NS) is None:
        return None
    g = node.find(f"p:{tag}/*/*", NS)
    return (g.text or "").strip() if g is not None else ""


# xs:date: YYYY-MM-DD, with an optional time zone that the tool ignores.
_DATE = re.compile(r"([0-9]{4}-[0-9]{2}-[0-9]{2})(?:Z|[+-][0-9]{2}:[0-9]{2})?")
# Plain ASCII decimals only, the same numbers docs/prlxml.js accepts.
_NUM = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")


def _d(s):
    """A real calendar day."""
    m = _DATE.fullmatch(s)
    if not m:
        raise ValueError(s)
    return date.fromisoformat(m[1])


def _num(s):
    """A Decimal, or None when s is not a plain number of sane size (100 digits, exponent within 100)."""
    if s is None:
        return None
    s = s.strip()
    if not _NUM.fullmatch(s):
        return None
    d = Decimal(s)
    t = d.as_tuple()
    if len(t.digits) > 100 or not -100 <= t.exponent <= 100:
        return None
    return d


# Field lengths from the Payroll XML Project Field Definitions (xml.aashtowareproject.org, resource kit 2.1).
# middleInitial (1) has its own rule below, so it is left out here to avoid reporting it twice.
MAX_LEN = {
    "vendorID": 20, "contractID": 20, "lastName": 40, "firstName": 40,
    "vendorSuppliedEmployeeID": 40, "ethnicity": 20, "craftCode": 20, "laborClass": 20, "projectID": 18,
    "PartialSsn": 20, "benefitProgramName": 80, "benefitAccountID": 40, "trusteeContactPerson": 40,
    "trusteeContactPhoneNumber": 13, "benefitProgramClass": 20, "apprenticeID": 20, "description": 256, "explanation": 256,
}


def _len_errors(node, who, extra=None):
    out = []
    for tag, n in list(MAX_LEN.items()) + list((extra or {}).items()):
        for e in node.iterfind(f"p:{tag}", NS):
            v = (e.text or "")
            if len(v) > n:
                out.append(f"{who}{tag} is {len(v)} characters, the limit is {n}")
    return out


def scan(xml_path: Path):
    """Returns (rule errors, warnings). Both are lists of plain-English lines."""
    with localcontext() as ctx:
        ctx.prec = 1000  # every sum and product of sane-size numbers stays exact
        return _scan(xml_path)


def _scan(xml_path: Path):
    errs, warns = [], []
    try:
        doc = etree.parse(str(xml_path))
    except (etree.XMLSyntaxError, OSError) as e:
        return [f"not well-formed XML: {e}"], []
    root = doc.getroot()
    if etree.QName(root).localname != "Payroll":
        return ["root element is not Payroll"], []
    if etree.QName(root).namespace != PRL_NS:
        return [f"Payroll XML 1.2 needs the namespace {PRL_NS}, this file has {etree.QName(root).namespace or '(none)'}"], []
    errs += _len_errors(root, "", {"comments": 256})

    b, e = _t(root, "payrollBeginDate"), _t(root, "payrollEndDate")
    try:
        begin, end = _d(b), _d(e)
        if (end - begin).days != 6:
            errs.append(f"pay period must be seven days: {begin} to {end} is {(end - begin).days + 1} days")
    except ValueError:
        errs.append(f"bad period date: begin {b!r}, end {e!r}")
        begin = end = None

    pn = _t(root, "payrollNumber")
    if not re.fullmatch(r"[0-9]+", pn) or int(pn) < 1:
        errs.append(f"payrollNumber must be a whole number starting at 1, got {pn!r}")
    if " " in _t(root, "contractID") or "-" in _t(root, "contractID"):
        errs.append("contractID must have no dashes or spaces")

    ft = _t(root, "fringeBenefitPaymentType")
    if ft not in FRINGE_TYPES:
        errs.append(f"fringeBenefitPaymentType must be Cash, Plan Funds, or Plan Funds with Exceptions, got {ft!r}")

    names = set()
    for i, prog in enumerate(root.iterfind(".//p:PayrollBenefitProgram", NS), start=1):
        who = f"benefit program {i}: "
        errs += _len_errors(prog, who)
        for tag in ("benefitProgramName", "benefitAccountID", "trusteeContactPerson", "trusteeContactPhoneNumber"):
            if not _t(prog, tag):
                errs.append(f"{who}{tag} is required")
        ptype = _t(prog, "benefitProgramType")
        if ptype not in PROGRAM_TYPES:
            errs.append(f"{who}benefitProgramType must be one of {', '.join(PROGRAM_TYPES)}, got {ptype!r}")
        elif ptype in ("Fringe Other 1", "Fringe Other 2") and not _t(prog, "benefitProgramClass"):
            errs.append(f"{who}benefitProgramClass is required for {ptype}")
        name = _t(prog, "benefitProgramName")
        if name and name in names:
            errs.append(f"{who}benefitProgramName {name!r} is used twice; each program needs its own name")
        names.add(name)

    if ft == "Plan Funds with Exceptions" and root.find(".//p:PayrollEmployeeFringeBenefitException", NS) is None:
        warns.append("fringe type is Plan Funds with Exceptions, but no employee has a fringe benefit exception")

    seen_people = OrderedDict()
    for emp in root.iterfind(".//p:PayrollEmployee", NS):
        who = f"{_t(emp, 'lastName')}, {_t(emp, 'firstName')}"
        seen_people[who] = seen_people.get(who, 0) + 1
        errs += _len_errors(emp, who + ": ", {"comments": 3999})
        g = _t(emp, "gender")
        if g and g not in ("Male", "Female"):
            errs.append(f"{who}: gender must be the word Male or Female, got {g!r}")
        if emp.find("p:changeIndicator", NS) is None:
            errs.append(f"{who}: changeIndicator is missing; the importing system requires true or false")
        mi = _t(emp, "middleInitial")
        if len(mi) > 1:
            errs.append(f"{who}: middleInitial must be one character, got {mi!r}")
        ssn = _t(emp, "socialSecurityNumber")
        if ssn and not re.fullmatch(r"[0-9]{9}", ssn):
            errs.append(f"{who}: socialSecurityNumber must be 9 digits, no dashes or spaces")
        if not (ssn or _t(emp, "PartialSsn") or _t(emp, "vendorSuppliedEmployeeID")):
            errs.append(f"{who}: no employee ID; give socialSecurityNumber, PartialSsn or vendorSuppliedEmployeeID, whichever your state asks for")
        salaried = _t(emp, "salariedEmployeeIndicator").lower() in TRUE

        emp_total = Decimal("0")
        emp_bad = False
        emp_days = OrderedDict()
        for lab in emp.iterfind(".//p:PayrollEmployeeLabor", NS):
            cls = _t(lab, "laborClass")
            errs += _len_errors(lab, f"{who} {cls}: ")

            rates = {}
            ot_zero = None  # an overtime rate of 0 is judged after the hours are counted
            if salaried:
                if _cur(lab, "straightTimeHourlyRate") is not None or _cur(lab, "overtimeHourlyRate") is not None:
                    errs.append(f"{who} {cls}: a salaried employee has no straightTimeHourlyRate or overtimeHourlyRate; take them out")
            else:
                for tag in ("straightTimeHourlyRate", "overtimeHourlyRate"):
                    v = _cur(lab, tag)
                    if not v:
                        errs.append(f"{who} {cls}: {tag} is required for an hourly employee")
                    elif _num(v) is None:
                        errs.append(f"{who} {cls}: {tag} {v!r} is not a number")
                    elif _num(v) < 0 or (_num(v) == 0 and tag == "straightTimeHourlyRate"):
                        errs.append(f"{who} {cls}: {tag} must be more than 0, got {v}")
                    else:
                        rates[tag] = _num(v)
                        if _num(v) == 0:
                            ot_zero = v

            has_fringe_rate = False
            for tag in FRINGE_RATES:
                v = _cur(lab, tag)
                if v is None:
                    continue
                if _num(v) is None:
                    errs.append(f"{who} {cls}: {tag} {v!r} is not a number")
                elif _num(v) <= 0:
                    errs.append(f"{who} {cls}: {tag} must be more than 0 when it is in the file, got {v}")
                else:
                    has_fringe_rate = True

            if _t(lab, "ojtProgramIndicator").lower() in TRUE and not _t(lab, "ojtWagePercentage"):
                errs.append(f"{who} {cls}: ojtWagePercentage is required when ojtProgramIndicator is true")
            if _t(lab, "apprentice").lower() in TRUE:
                for tag in ("apprenticeID", "apprenticeWagePercentage"):
                    if not _t(lab, tag):
                        errs.append(f"{who} {cls}: {tag} is required when apprentice is true")

            st_sum = ot_sum = sal_sum = Decimal("0")
            days_ok = True
            seen_days = set()
            for h in lab.iterfind(".//p:PayrollEmployeeLaborHour", NS):
                try:
                    d = _d(_t(h, "laborHourDate"))
                except ValueError:
                    errs.append(f"{who} {cls}: bad laborHourDate {_t(h, 'laborHourDate')!r}")
                    days_ok = False
                    continue
                if begin and not (begin <= d <= end):
                    errs.append(f"{who} {cls}: hours on {d} fall outside the pay period")
                if d in seen_days:
                    warns.append(f"{who} {cls}: {d} is listed twice; merge it into one day")
                seen_days.add(d)
                hh = h.find("p:hourlyHours", NS)
                sh = h.find("p:salariedEmployeeHours", NS)
                if hh is not None:
                    if salaried:
                        errs.append(f"{who} {cls} {d}: a salaried employee reports salariedEmployeeHours, not straight and overtime hours")
                    st = _t(hh, "straightTimeHours")
                    ot = _t(hh, "overtimeHours")
                    ot_tag = hh.find("p:overtimeHours", NS) is not None
                    if st == "" or (ot_tag and ot == ""):
                        errs.append(f"{who} {cls} {d}: straight and overtime hours must both be filled, use 0.00")
                    elif not ot_tag:
                        warns.append(f"{who} {cls} {d}: overtimeHours is left out; Wisconsin's import wants 0.00 on a day with no overtime")
                    st_n, ot_n = _num(st or "0"), _num(ot or "0")
                    if st_n is None or ot_n is None:
                        errs.append(f"{who} {cls} {d}: hours must be numbers, got {st!r} and {ot!r}")
                        days_ok = False
                        continue
                    if st_n < 0 or ot_n < 0:
                        errs.append(f"{who} {cls} {d}: hours cannot be below 0")
                    st_sum += st_n
                    ot_sum += ot_n
                    day = st_n + ot_n
                elif sh is not None:
                    if not salaried:
                        errs.append(f"{who} {cls} {d}: salariedEmployeeHours is only for a salaried employee; use straightTimeHours and overtimeHours")
                    s = (sh.text or "").strip()
                    s_n = _num(s)
                    if s_n is None:
                        errs.append(f"{who} {cls} {d}: salariedEmployeeHours must be a number, got {s!r}")
                        days_ok = False
                        continue
                    if s_n < 0:
                        errs.append(f"{who} {cls} {d}: hours cannot be below 0")
                    sal_sum += s_n
                    day = s_n
                else:
                    continue
                emp_days[d] = emp_days.get(d, Decimal("0")) + day
            if not days_ok:
                emp_bad = True
            emp_total += st_sum + ot_sum + sal_sum
            if ot_zero is not None:
                if ot_sum > 0:
                    errs.append(f"{who} {cls}: overtimeHourlyRate must be more than 0 when there is overtime, got {ot_zero}")
                else:
                    warns.append(f"{who} {cls}: overtimeHourlyRate is {ot_zero}; some states want a rate above 0 even with no overtime")

            # A salaried line reports salariedEmployeeHours by day, so its straight and overtime totals are not compared.
            for tag, val in () if salaried else (("straightTimeHours", st_sum), ("overtimeHours", ot_sum)):
                tot = _t(lab, tag)
                if tag == "straightTimeHours" and not tot:
                    errs.append(f"{who} {cls}: straightTimeHours is required, use 0.00 when there were none")
                elif tot:
                    tv = _num(tot)
                    if tv is None:
                        errs.append(f"{who} {cls}: {tag} total {tot!r} is not a number")
                    elif tv != val:
                        errs.append(f"{who} {cls}: {tag} total {tot} does not match the daily sum {val:.2f}")
            tot = _t(lab, "totalHours")
            if not tot:
                errs.append(f"{who} {cls}: totalHours is required")
            else:
                tv = _num(tot)
                if tv is None:
                    errs.append(f"{who} {cls}: totalHours {tot!r} is not a number")
                elif tv != st_sum + ot_sum + sal_sum:
                    errs.append(f"{who} {cls}: totalHours {tot} does not match the daily sum {st_sum + ot_sum + sal_sum:.2f}")

            for tag in ("grossPay", "totalDeductions", "netPay"):
                if not _cur(lab, tag):
                    errs.append(f"{who} {cls}: {tag} is required")
            gross = lab.find("p:grossPay/*/*", NS)
            ded = lab.find("p:totalDeductions/*/*", NS)
            net = lab.find("p:netPay/*/*", NS)
            gv = dv = None
            if gross is not None and ded is not None and net is not None:
                gv, dv, nv = _num(gross.text), _num(ded.text), _num(net.text)
                if gv is None or dv is None or nv is None:
                    errs.append(f"{who} {cls}: grossPay, totalDeductions and netPay must be numbers")
                elif gv - dv != nv:
                    errs.append(f"{who} {cls}: grossPay minus totalDeductions is not netPay ({gross.text} - {ded.text} != {net.text})")
            pv = None
            gpe = _cur(lab, "grossProjectAmountEarned")
            if not gpe:
                errs.append(f"{who} {cls}: grossProjectAmountEarned is required, the pay for this contract and project only")
            elif _num(gpe) is None:
                errs.append(f"{who} {cls}: grossProjectAmountEarned {gpe!r} is not a number")
            else:
                pv = _num(gpe)

            parts = Decimal("0")
            tax_seen = False
            parts_ok = True
            for tag in DEDUCTION_PARTS:
                v = _cur(lab, tag)
                if v is None:
                    continue
                tax_seen = True
                if _num(v or "0") is None:
                    errs.append(f"{who} {cls}: {tag} {v!r} is not a number")
                    parts_ok = False
                else:
                    parts += _num(v or "0")
            descs = set()
            for od in lab.iterfind(".//p:PayrollEmployeeOtherDeduction", NS):
                errs += _len_errors(od, f"{who} {cls}: ")
                desc = _t(od, "description")
                if desc in descs:
                    errs.append(f"{who} {cls}: other deduction {desc!r} is listed twice; each description must be unique")
                descs.add(desc)
                v = _cur(od, "amount")
                if v is None:
                    continue
                if _num(v or "0") is None:
                    errs.append(f"{who} {cls}: other deduction {desc!r} amount {v!r} is not a number")
                    parts_ok = False
                else:
                    parts += _num(v or "0")
            for ex in lab.iterfind(".//p:PayrollEmployeeFringeBenefitException", NS):
                errs += _len_errors(ex, f"{who} {cls}: ")

            # The four tax fields are optional. With none of them in the file the parts cannot be added up.
            if tax_seen and parts_ok and dv is not None and parts != dv:
                warns.append(f"{who} {cls}: FICA, federal, state, Medicare and other deductions add up to {parts:.2f}, but totalDeductions is {ded.text.strip()}; totalDeductions should include all taxes and other deductions")

            under = False
            if not salaried and days_ok and len(rates) == 2 and rates["straightTimeHourlyRate"] > 0:
                calc = (rates["straightTimeHourlyRate"] * st_sum + rates["overtimeHourlyRate"] * ot_sum).quantize(CENT, rounding=ROUND_HALF_EVEN)
                if pv is not None and calc - pv > CENT:
                    warns.append(f"{who} {cls}: grossProjectAmountEarned {gpe} is less than the hours times the rates ({calc:.2f}); that reads as underpayment")
                    under = True
                elif gv is not None and calc - gv > CENT:
                    warns.append(f"{who} {cls}: grossPay {gross.text.strip()} is less than the hours times the rates ({calc:.2f}); that reads as underpayment")
                    under = True
            if not under and gv is not None and pv is not None and gv < pv:
                warns.append(f"{who} {cls}: grossPay {gross.text.strip()} is less than grossProjectAmountEarned {gpe}; gross pay should be the project pay plus any other pay")
            if len(rates) == 2 and ot_sum > 0 and 0 < rates["overtimeHourlyRate"] < rates["straightTimeHourlyRate"]:
                warns.append(f"{who} {cls}: overtime rate {_cur(lab, 'overtimeHourlyRate')} is lower than the straight rate {_cur(lab, 'straightTimeHourlyRate')}")
            if ft in PLAN_FUNDS and not has_fringe_rate:
                if ft == "Plan Funds" or lab.find(".//p:PayrollEmployeeFringeBenefitException", NS) is None:
                    warns.append(f"{who} {cls}: fringe type is {ft} but this line has no fringe rate; fill at least one fringe rate and fringeBenefits")

        if not emp_bad and emp_total == 0:
            warns.append(f"{who}: no hours on this payroll; a state that sets Include Employees with Zero Hours to False rejects the file")
        for d, hours in emp_days.items():
            if hours > 24:
                warns.append(f"{who}: {d} adds up to {hours:.2f} hours, more than a day holds")

    for who, n in seen_people.items():
        if n > 1:
            warns.append(f"{who}: listed as {n} separate employees; if this is one person, put all of their labor lines under one employee")
    return errs, warns


def rule_errors(xml_path: Path):
    """Things the field definitions require or an import rejects."""
    return scan(xml_path)[0]


def warnings(xml_path: Path):
    """Things a state reviewer would question. The file may still import."""
    return scan(xml_path)[1]


_HEADER = (("vendor", "vendorID"), ("contract", "contractID"), ("number", "payrollNumber"),
           ("begin", "payrollBeginDate"), ("end", "payrollEndDate"))


def header(xml_path: Path):
    """The fields that place one payroll among others. None when the file is not readable Payroll XML."""
    try:
        root = etree.parse(str(xml_path)).getroot()
    except (etree.XMLSyntaxError, OSError):
        return None
    if etree.QName(root).localname != "Payroll" or etree.QName(root).namespace != PRL_NS:
        return None
    return {k: _t(root, tag).strip("\ufeff").strip() for k, tag in _HEADER}  # JS trim() also drops U+FEFF


def across(items):
    """Warnings about files that clash with each other. items: (name, header or None) pairs, in order."""
    out = []
    ok = [(n, h) for n, h in items if h and h["contract"]]
    for i in range(len(ok)):
        a, ha = ok[i]
        for b, hb in ok[i + 1:]:
            if (ha["vendor"], ha["contract"]) != (hb["vendor"], hb["contract"]):
                continue
            who = f"contract {ha['contract']}" + (f", vendor {ha['vendor']}" if ha["vendor"] else "")
            if ha["number"] and ha["number"] == hb["number"]:
                out.append(f"{a} and {b} are both payroll number {ha['number']} for {who}. If one is not a correction of the other, renumber it")
                continue
            try:
                a0, a1, b0, b1 = _d(ha["begin"]), _d(ha["end"]), _d(hb["begin"]), _d(hb["end"])
            except ValueError:
                continue
            if a0 <= b1 and b0 <= a1:
                out.append(f"{a} (payroll {ha['number']}, {a0} to {a1}) and {b} (payroll {hb['number']}, {b0} to {b1}) cover the same days for {who}")
    return out


def _report(xml_path: Path, schema_dir: Path) -> bool:
    s = schema_errors(xml_path, schema_dir)
    r, w = scan(xml_path)
    for e in s:
        print(f"SCHEMA  {e}")
    for e in r:
        print(f"RULE    {e}")
    for e in w:
        print(f"WARN    {e}")
    if not s and not r:
        tail = f", {len(w)} warning{'s' if len(w) != 1 else ''} to look at" if w else ""
        print(f"OK {xml_path}: schema valid, rules clean{tail}")
        return True
    print(f"{len(s)} schema errors, {len(r)} rule errors, {len(w)} warnings")
    return False


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Check Payroll XML files against the schema and the import rules")
    p.add_argument("xml", type=Path, nargs="+", help="one file, or several (a week per file) to check together")
    p.add_argument("--schemas", type=Path, default=Path("schemas"))
    a = p.parse_args(argv)
    a.xml = expand_globs(a.xml)
    if len(a.xml) == 1:
        return 0 if _report(a.xml[0], a.schemas) else 1
    bad = 0
    for x in a.xml:
        print(f"== {x}")
        if not _report(x, a.schemas):
            bad += 1
    clash = across([(str(x), header(x)) for x in a.xml])
    if clash:
        print("== across files")
    for c in clash:
        print(f"WARN    {c}")
    n = len(a.xml)
    tail = f", {len(clash)} warning{'s' if len(clash) != 1 else ''} across files" if clash else ""
    print(f"{n} files: {n - bad} OK, {bad} with errors{tail}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
