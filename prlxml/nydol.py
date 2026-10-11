"""New York State DOL certified payroll: convert a CSV to the state's bulk upload XML, and check a file.

Since 2025-12-31 New York requires contractors on public work to upload weekly certified
payroll to the NYS DOL Certified Payroll System. The bulk upload is one XML file per
project (PRC number) per week, in the state's own format (NYDOL_CertPayroll.xsd). It is
not Payroll XML 1.2.

    python -m prlxml.nydol convert week.csv -o week.xml
    python -m prlxml.nydol check week.xml

The check runs the state schema when it is in schemas/nydol (python -m prlxml.fetch_schemas ny),
then rules from the state's formatting guide and its list of upload errors. docs/nydol.js is
the same code for the browser page; tests/test_nydol.py holds the two to the same answers.
"""
import argparse
import csv
import io
import re
import sys
from datetime import date, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

from .convert import ConvertError, decode as decode_csv_bytes  # same encoding rules as the main converter

NY_XSD = "NYDOL_CertPayroll.xsd"

STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "PR": "Puerto Rico", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}

# CSV fringe columns, in output order, and the state's type for each.
FRINGES = (
    ("health", "Health/Welfare"),
    ("vacation", "Vacation/Holiday"),
    ("training", "Apprenticeship/Training"),
    ("pension", "Pension"),
    ("other", "Other Benefit (Type)"),
)
SUPP_TYPES = tuple(t for _, t in FRINGES)
OTHER = "Other Benefit (Type)"

REQUIRED = (
    "prc_number", "week_ending", "last_name", "first_name", "address1", "city", "state", "zip",
    "gross_earnings", "net_wages", "work_category", "st_rate", "ot_rate", "work_date", "st_hours", "ot_hours",
)
EMPLOYEE_COLS = (
    "middle_name", "ssn_last4", "date_of_birth", "apprentice", "address1", "address2", "city", "state",
    "zip", "country", "gross_earnings", "net_wages", "deductions",
)
CLASS_COLS = ("st_rate", "ot_rate") + tuple(c for f, _ in FRINGES for c in (f, f + "_ot")) + ("other_explanation",)

# The state schema's limits. Characters for text, hundredths for numbers.
TEXT_LIMITS = (
    ("first_name", "firstName", 45), ("middle_name", "middleName", 45), ("last_name", "lastName", 45),
    ("address1", "address1", 42), ("address2", "address2", 42), ("city", "city", 40),
    ("country", "country", 50), ("work_category", "workCategory", 300), ("other_explanation", "explanation", 256),
)
NUM_LIMITS = (
    ("gross_earnings", "deductionsGrossEarnings", 99999999), ("net_wages", "netWages", 99999999),
    ("st_rate", "stHourlyRate", 99999), ("ot_rate", "otHourlyRate", 99999),
) + tuple((c, "supplement rate", 1000000) for f, _ in FRINGES for c in (f, f + "_ot"))
DEDUCTION_TYPE_MAX = 50
DEDUCTION_MAX = 999999  # the schema's amount pattern takes at most 4 digits before the point

TRUE_WORDS = ("y", "yes", "true", "1")
FALSE_WORDS = ("", "n", "no", "false", "0")




# ---------- numbers: whole cents and hundredths, so Python and the browser agree exactly ----------

_DEC = re.compile(r"([+-]?)([0-9]*)(?:\.([0-9]*))?")


def hundredths(s):
    """'8', '8.5', '8.50', '+8.500' -> 850. '-1.25' -> -125. None when not a plain number or finer than 0.01."""
    if s is None:
        return None
    s = s.strip()
    m = _DEC.fullmatch(s)
    if not m or not (m[2] or m[3]) or len(s) > 15:
        return None
    frac = (m[3] or "").rstrip("0")
    if len(frac) > 2:
        return None
    v = int(m[2] or "0") * 100 + int((frac + "00")[:2])
    return -v if m[1] == "-" else v


def money(n):
    """850 -> '8.50', -125 -> '-1.25'."""
    sign = "-" if n < 0 else ""
    n = abs(n)
    return f"{sign}{n // 100}.{n % 100:02d}"


# ---------- dates ----------

_ISO = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_US = re.compile(r"([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})")


def parse_day(s):
    """2025-08-03 or 8/3/2025 -> date. None when not a real day."""
    s = (s or "").strip()
    m = _ISO.fullmatch(s)
    try:
        if m:
            return date(int(m[1]), int(m[2]), int(m[3]))
        m = _US.fullmatch(s)
        if m:
            return date(int(m[3]), int(m[1]), int(m[2]))
    except ValueError:
        return None
    return None


# ---------- convert ----------

def _rows(text):
    text = re.sub(r"\A(?:\r\n|\r|\n)+", "", text)
    reader = csv.reader(io.StringIO(text, newline=""))
    try:
        head = next(reader)
    except StopIteration:
        raise ConvertError("the file is empty")
    head = [h.strip().lower() for h in head]
    missing = [c for c in REQUIRED if c not in head]
    if missing:
        raise ConvertError("missing columns: " + ", ".join(missing))
    out = []
    for n, cells in enumerate(reader, start=2):
        if not any(c.strip() for c in cells):
            continue
        row = {h: (cells[i].strip() if i < len(cells) else "") for i, h in enumerate(head)}
        row["_line"] = n
        out.append(row)
    if not out:
        raise ConvertError("no data rows")
    return out


def _need_num(row, col, label=None):
    v = row.get(col, "")
    n = hundredths(v)
    if n is None:
        raise ConvertError(f"row {row['_line']}: {col} '{v}' is not a number with at most 2 decimals")
    if n < 0:
        raise ConvertError(f"row {row['_line']}: {col} is below 0")
    return n


def _ssn4(row):
    v = row.get("ssn_last4", "")
    digits = re.sub(r"[\s-]", "", v)
    if not digits:
        return ""
    if not digits.isdigit() or len(digits) not in (4, 9):
        raise ConvertError(f"row {row['_line']}: ssn_last4 must be the last 4 digits (a full 9 digit SSN is cut to its last 4)")
    return digits[-4:]


def _zip(row):
    v = row.get("zip", "")
    m = re.fullmatch(r"([0-9]{3,5})(?:-?([0-9]{4}))?", v)
    if not m:
        raise ConvertError(f"row {row['_line']}: zip '{v}' is not a 5 digit ZIP or ZIP+4")
    return m[1].zfill(5), m[2] or ""


def _state(row):
    v = row.get("state", "")
    return STATES.get(v.upper().replace(".", ""), v)


def _apprentice(row):
    v = row.get("apprentice", "").lower()
    if v in TRUE_WORDS:
        return "true"
    if v in FALSE_WORDS:
        return "false"
    raise ConvertError(f"row {row['_line']}: apprentice '{row.get('apprentice')}' must be Y or N")


def _deductions(row):
    v = row.get("deductions", "")
    out = []
    for part in [p.strip() for p in v.split(";") if p.strip()]:
        if ":" not in part:
            raise ConvertError(f"row {row['_line']}: deduction '{part}' must be written type:amount")
        t, a = part.rsplit(":", 1)
        t = t.strip()
        n = hundredths(a)
        if not t or n is None or n < 0:
            raise ConvertError(f"row {row['_line']}: deduction '{part}' must be written type:amount")
        if len(t) > DEDUCTION_TYPE_MAX:
            raise ConvertError(f"row {row['_line']}: deduction type '{t}' is {len(t)} characters; the state takes at most {DEDUCTION_TYPE_MAX}")
        if n > DEDUCTION_MAX:
            raise ConvertError(f"row {row['_line']}: deduction '{t}' is {money(n)}; the state takes at most {money(DEDUCTION_MAX)}")
        out.append((t, n))
    if len(out) > 10:
        raise ConvertError(f"row {row['_line']}: the state takes at most 10 deductions per worker")
    return out


def _fringes(row):
    out = []
    for col, typ in FRINGES:
        st = hundredths(row.get(col, "") or "0")
        ot_raw = row.get(col + "_ot", "")
        ot = hundredths(ot_raw) if ot_raw else st
        if st is None or ot is None or st < 0 or ot < 0:
            raise ConvertError(f"row {row['_line']}: {col} fringe rate must be a number with at most 2 decimals")
        if st == 0 and ot == 0:
            continue
        expl = row.get("other_explanation", "") if typ == OTHER else ""
        if typ == OTHER and not expl:
            raise ConvertError(f"row {row['_line']}: an other fringe needs other_explanation (the state rejects it without one)")
        out.append((typ, st, ot, expl))
    return out


def _limits(row):
    for col, _, most in TEXT_LIMITS:
        v = row.get(col, "")
        if len(v) > most:
            raise ConvertError(f"row {row['_line']}: {col} is {len(v)} characters; the state takes at most {most}")
    if len(_state(row)) > 50:
        raise ConvertError(f"row {row['_line']}: state is {len(_state(row))} characters; the state takes at most 50")
    for col, _, most in NUM_LIMITS:
        n = hundredths(row.get(col, ""))
        if n is not None and n > most:
            raise ConvertError(f"row {row['_line']}: {col} is {money(n)}; the state takes at most {money(most)}")


def _same(first, row, cols, what):
    for c in cols:
        if first.get(c, "") != row.get(c, ""):
            raise ConvertError(
                f"row {row['_line']}: {c} '{row.get(c, '')}' differs from row {first['_line']} ('{first.get(c, '')}') for {what}"
            )


def convert_csv(text: str) -> str:
    rows = _rows(text)
    first = rows[0]
    prc = first["prc_number"]
    if len(prc) != 10:
        raise ConvertError(f"row {first['_line']}: prc_number '{prc}' must be 10 characters")
    end = parse_day(first["week_ending"])
    if end is None:
        raise ConvertError(f"row {first['_line']}: week_ending '{first['week_ending']}' is not a date")
    start = end - timedelta(days=6)
    for r in rows:
        if r["prc_number"] != prc:
            raise ConvertError(f"row {r['_line']}: a file holds one project; prc_number differs from row {first['_line']}")
        if parse_day(r["week_ending"]) != end:
            raise ConvertError(f"row {r['_line']}: a file holds one week; week_ending differs from row {first['_line']}")

    people = {}  # key -> {"row": first row, "classes": {category: {"row":, "days": {date: (st, ot)}}}}
    for r in rows:
        for c in ("last_name", "first_name", "work_category", "address1", "city", "state"):
            if not r.get(c):
                raise ConvertError(f"row {r['_line']}: {c} is blank")
        _limits(r)
        ssn4 = _ssn4(r)
        dob = r.get("date_of_birth", "")
        if dob and parse_day(dob) is None:
            raise ConvertError(f"row {r['_line']}: date_of_birth '{dob}' is not a date")
        if dob:
            dob = r["date_of_birth"] = parse_day(dob).isoformat()  # 4/17/1999 and 1999-04-17 are one person
        if bool(ssn4) == bool(dob):
            raise ConvertError(f"row {r['_line']}: give ssn_last4 or date_of_birth, one of them, not both and not neither")
        key = (r["last_name"].lower(), r["first_name"].lower(), r.get("middle_name", "").lower(), ssn4, dob)
        p = people.get(key)
        if p is None:
            p = people[key] = {"row": r, "classes": {}}
        else:
            _same(p["row"], r, EMPLOYEE_COLS, f"{r['first_name']} {r['last_name']}")
        cat = r["work_category"]
        k = p["classes"].get(cat)
        if k is None:
            k = p["classes"][cat] = {"row": r, "days": {}}
        else:
            _same(k["row"], r, CLASS_COLS, f"{r['first_name']} {r['last_name']}, {cat}")
        d = parse_day(r["work_date"])
        if d is None:
            raise ConvertError(f"row {r['_line']}: work_date '{r['work_date']}' is not a date")
        if not start <= d <= end:
            raise ConvertError(f"row {r['_line']}: work_date {d.isoformat()} is outside the week {start.isoformat()} to {end.isoformat()}")
        if d in k["days"]:
            raise ConvertError(f"row {r['_line']}: {d.isoformat()} is listed twice for {r['first_name']} {r['last_name']}, {cat}; put the hours on one row")
        st = _need_num(r, "st_hours")
        ot = _need_num(r, "ot_hours")
        if st > 2400 or ot > 2400:
            raise ConvertError(f"row {r['_line']}: the state takes at most 24 hours in one day")
        k["days"][d] = (st, ot)
    if len(people) > 500:
        raise ConvertError("the state takes at most 500 workers in one file; split it")

    o = ['<?xml version="1.0" encoding="UTF-8"?>']
    o.append('<ProjectRollup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="NYDOL_CertPayroll.xsd">')
    o.append(f"    <prcNumber>{escape(prc)}</prcNumber>")
    o.append(f"    <weekEndingDate>{end.isoformat()}T00:00:00.000Z</weekEndingDate>")
    o.append("    <employeeWorkWeeks>")
    for p in people.values():
        r = p["row"]
        z5, z4 = _zip(r)
        ded = _deductions(r)
        gross = _need_num(r, "gross_earnings")
        net = _need_num(r, "net_wages")

        def el(depth, tag, val):
            o.append(" " * (4 * depth) + f"<{tag}>{escape(val)}</{tag}>")

        o.append("        <employeeWorkWeek>")
        o.append("            <employee>")
        el(4, "firstName", r["first_name"])
        if r.get("middle_name"):
            el(4, "middleName", r["middle_name"])
        el(4, "lastName", r["last_name"])
        if r.get("date_of_birth"):
            el(4, "dateOfBirth", parse_day(r["date_of_birth"]).isoformat())
        else:
            el(4, "ssnLast4", _ssn4(r))
        el(4, "nysRegisteredApprentice", _apprentice(r))
        o.append("                <address>")
        el(5, "address1", r["address1"])
        if r.get("address2"):
            el(5, "address2", r["address2"])
        el(5, "city", r["city"])
        el(5, "state", _state(r))
        el(5, "postalCode", z5)
        if z4:
            el(5, "postalCodeExt", z4)
        el(5, "country", r.get("country") or "United States")
        o.append("                </address>")
        o.append("            </employee>")
        el(3, "deductionsGrossEarnings", money(gross))
        el(3, "netWages", money(net))
        o.append("            <workWeeks>")
        supps = []
        for cat, k in p["classes"].items():
            kr = k["row"]
            o.append("                <workWeek>")
            el(5, "workCategory", cat)
            el(5, "stHourlyRate", money(_need_num(kr, "st_rate")))
            el(5, "otHourlyRate", money(_need_num(kr, "ot_rate")))
            o.append("                    <days>")
            for d in sorted(k["days"]):
                st, ot = k["days"][d]
                o.append("                        <day>")
                el(7, "day", d.isoformat())
                el(7, "standardTimeHours", money(st))
                el(7, "overTimeHours", money(ot))
                o.append("                        </day>")
            o.append("                    </days>")
            o.append("                </workWeek>")
            supps += [(cat,) + f for f in _fringes(kr)]
        o.append("            </workWeeks>")
        if ded:
            o.append("            <deductions>")
            for t, n in ded:
                o.append("                <deduction>")
                el(5, "type", t)
                el(5, "amount", money(n))
                o.append("                </deduction>")
            o.append("            </deductions>")
        else:
            o.append("            <deductions/>")
        if len(supps) > 50:
            raise ConvertError(f"{r['first_name']} {r['last_name']}: the state takes at most 50 fringe lines per worker")
        if supps:
            o.append("            <supplementalPayments>")
            for cat, typ, st, ot, expl in supps:
                o.append("                <supplementalPayment>")
                el(5, "type", typ)
                el(5, "workCategory", cat)
                if expl:
                    el(5, "explanation", expl)
                el(5, "standardHourlyRate", money(st))
                el(5, "overtimeHourlyRate", money(ot))
                o.append("                </supplementalPayment>")
            o.append("            </supplementalPayments>")
        else:
            o.append("            <supplementalPayments/>")
        o.append("        </employeeWorkWeek>")
    o.append("    </employeeWorkWeeks>")
    o.append("</ProjectRollup>")
    return "\n".join(o) + "\n"


# ---------- check ----------
# The rules run on a plain tree (tag, text, children) so docs/nydol.js can run the same code on a browser DOM.

class Node:
    __slots__ = ("tag", "text", "kids")

    def __init__(self, tag, text, kids):
        self.tag, self.text, self.kids = tag, text, kids

    def all(self, tag):
        return [k for k in self.kids if k.tag == tag]

    def one(self, tag):
        for k in self.kids:
            if k.tag == tag:
                return k
        return None

    def val(self, tag):
        k = self.one(tag)
        return k.text.strip() if k is not None else None


def tree_from_lxml(el):
    tag = el.tag.split("}")[-1] if isinstance(el.tag, str) else ""
    kids = [tree_from_lxml(k) for k in el if isinstance(k.tag, str)]
    text = "".join(el.itertext()) if not kids else ""
    return Node(tag, text, kids)


def _len_err(errors, who, tag, v, most):
    if v is not None and len(v) > most:
        errors.append(f"{who}: {tag} is {len(v)} characters; the state takes at most {most}")


def _max_err(errors, who, tag, n, most):
    if n is not None and n > most:
        errors.append(f"{who}: {tag} is {money(n)}; the state takes at most {money(most)}")


def rule_check(root):
    """Return (errors, warnings) for a ProjectRollup tree."""
    errors, warnings = [], []
    if root.tag != "ProjectRollup":
        return [f"the top element is {root.tag}, not ProjectRollup"], []
    prc = root.val("prcNumber")
    if prc is not None and len(prc) != 10:
        errors.append(f"prcNumber '{prc}' must be 10 characters")
    wk = root.val("weekEndingDate")
    end = None
    if wk is not None:
        m = re.fullmatch(r"([0-9]{4}-[0-9]{2}-[0-9]{2})(T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)?", wk)
        end = parse_day(m[1]) if m else None
        if m and not m[2] and end:
            errors.append(f"weekEndingDate needs the time on it: write {m[1]}T00:00:00.000Z")
        elif end is None:
            errors.append(f"weekEndingDate '{wk}' is not a date like 2025-08-03T00:00:00.000Z")
    start = end - timedelta(days=6) if end else None
    wrap = root.one("employeeWorkWeeks")
    ews = wrap.all("employeeWorkWeek") if wrap is not None else []
    seen = {}
    for i, ew in enumerate(ews, start=1):
        emp = ew.one("employee")
        if emp is None:
            continue
        name = " ".join(x for x in (emp.val("firstName"), emp.val("lastName")) if x)
        who = f"employee {i} ({name})"
        ssn4, dob = emp.val("ssnLast4"), emp.val("dateOfBirth")
        if ssn4 and dob:
            errors.append(f"{who}: has both ssnLast4 and dateOfBirth; the state takes one, not both")
        if not ssn4 and not dob:
            errors.append(f"{who}: needs ssnLast4 or dateOfBirth")
        key = ((emp.val("firstName") or "").lower(), (emp.val("lastName") or "").lower(), ssn4 or "", dob or "")
        if key in seen:
            errors.append(f"{who}: same worker as employee {seen[key]}; the state rejects duplicate employees (put both classifications under one employee)")
        else:
            seen[key] = i
        for tag, most in (("firstName", 45), ("middleName", 45), ("lastName", 45)):
            _len_err(errors, who, tag, emp.val(tag), most)
        appr = emp.val("nysRegisteredApprentice")
        if appr is not None and appr not in ("true", "false", "1", "0"):
            errors.append(f"{who}: nysRegisteredApprentice is '{appr}'; write true or false (the schema note says Y or N, but the schema only takes true or false)")
        addr = emp.one("address")
        if addr is not None:
            st = addr.val("state")
            if st and st.upper().replace(".", "") in STATES:
                errors.append(f"{who}: state '{st}' must be the full name ({STATES[st.upper().replace('.', '')]})")
            for tag, most in (("address1", 42), ("address2", 42), ("city", 40), ("state", 50), ("country", 50)):
                _len_err(errors, who, tag, addr.val(tag), most)
            if addr.one("country") is None:
                errors.append(f"{who}: address has no country; the schema requires it even though the state's guide page marks it optional (use United States)")
        if dob:
            b = parse_day(dob)
            if b and end and (b > end - timedelta(days=365 * 14) or b < end - timedelta(days=365 * 100)):
                warnings.append(f"{who}: dateOfBirth {dob} gives an age under 14 or over 100")
        if ew.one("deductionGrossEarnings") is not None:
            errors.append(f"{who}: the element is deductionsGrossEarnings, with an s; the state's guide page spells it without")
        gross = hundredths(ew.val("deductionsGrossEarnings"))
        net = hundredths(ew.val("netWages"))
        for tag, v in (("deductionsGrossEarnings", gross), ("netWages", net)):
            if v is not None and v < 0:
                errors.append(f"{who}: {tag} is below 0")
            _max_err(errors, who, tag, v, 99999999)
        cats, total_hours, earned = {}, 0, 0  # earned in 1/10000 dollars
        wws = ew.one("workWeeks")
        for w in (wws.all("workWeek") if wws is not None else []):
            cat = w.val("workCategory") or ""
            here = f"{who}, {cat}"
            if cat in cats:
                warnings.append(f"{here}: listed twice; one workWeek per classification")
            cats[cat] = True
            str_ = hundredths(w.val("stHourlyRate"))
            otr = hundredths(w.val("otHourlyRate"))
            _len_err(errors, who, "workCategory", cat, 300)
            for tag, v in (("stHourlyRate", str_), ("otHourlyRate", otr)):
                if v is not None and v < 0:
                    errors.append(f"{here}: {tag} is below 0")
                _max_err(errors, here, tag, v, 99999)
            if str_ is not None and str_ == 0:
                errors.append(f"{here}: stHourlyRate is 0.00")
            days = w.one("days")
            dates, ot_total = {}, 0
            for d in (days.all("day") if days is not None else []):
                dv = d.val("day")
                dd = parse_day(dv) if dv and _ISO.fullmatch(dv) else None
                sth, oth = hundredths(d.val("standardTimeHours")), hundredths(d.val("overTimeHours"))
                for tag, v in (("standardTimeHours", sth), ("overTimeHours", oth)):
                    if v is not None and v < 0:
                        errors.append(f"{here}, {dv}: {tag} is below 0")
                if dd and start and not start <= dd <= end:
                    errors.append(f"{here}: day {dv} is outside the week {start.isoformat()} to {end.isoformat()}")
                if dd:
                    if dd in dates:
                        warnings.append(f"{here}: day {dv} is listed twice")
                    dates[dd] = True
                if sth is not None and oth is not None and sth + oth > 2400:
                    warnings.append(f"{here}, {dv}: more than 24 hours in one day")
                if sth is not None and sth > 0:
                    total_hours += sth
                    if str_ is not None and str_ > 0:
                        earned += sth * str_
                if oth is not None and oth > 0:
                    total_hours += oth
                    ot_total += oth
                    if otr is not None and otr > 0:
                        earned += oth * otr
            if ot_total > 0 and otr is not None and str_ is not None and otr < str_:
                warnings.append(f"{here}: otHourlyRate {money(otr)} is below stHourlyRate {money(str_)}")
        if total_hours == 0:
            warnings.append(f"{who}: no hours this week")
        if gross is not None and gross * 100 < earned:
            warnings.append(f"{who}: deductionsGrossEarnings {money(gross)} is below the hours times the rates ({money(earned // 100)})")
        dwrap = ew.one("deductions")
        dsum, dok = 0, True
        for d in (dwrap.all("deduction") if dwrap is not None else []):
            _len_err(errors, who, "deduction type", d.val("type"), DEDUCTION_TYPE_MAX)
            a = hundredths(d.val("amount"))
            _max_err(errors, who, "deduction " + (d.val("type") or ""), a, DEDUCTION_MAX)
            if a is None:
                dok = False
            else:
                dsum += a
        if dok and gross is not None and net is not None and gross - dsum != net:
            warnings.append(
                f"{who}: deductionsGrossEarnings {money(gross)} minus deductions {money(dsum)} is {money(gross - dsum)}, but netWages is {money(net)}"
            )
        swrap = ew.one("supplementalPayments")
        for s in (swrap.all("supplementalPayment") if swrap is not None else []):
            typ, expl, scat = s.val("type"), s.val("explanation"), s.val("workCategory")
            _len_err(errors, who, "explanation", expl, 256)
            for tag in ("standardHourlyRate", "overtimeHourlyRate"):
                _max_err(errors, who, f"{typ or ''} {tag}", hundredths(s.val(tag)), 1000000)
            if typ == OTHER and not expl:
                errors.append(f"{who}: an {OTHER} fringe needs an explanation")
            if typ is not None and typ != OTHER and expl:
                errors.append(f"{who}: a {typ} fringe has an explanation; the state takes one only on {OTHER}")
            if scat is not None and scat not in cats:
                warnings.append(f"{who}: fringe for '{scat}', which is not one of this worker's classifications")
    return errors, warnings


def check_file(path: Path, schema_dir: Path):
    from lxml import etree

    try:
        doc = etree.parse(str(path))
    except (etree.XMLSyntaxError, OSError) as e:
        return [f"not well-formed XML: {e}"], [], None
    xsd = schema_dir / NY_XSD
    schema_msgs = None
    if xsd.exists():
        schema = etree.XMLSchema(etree.parse(str(xsd)))
        schema_msgs = [] if schema.validate(doc) else [f"line {e.line}: {e.message}" for e in schema.error_log]
    errors, warnings = rule_check(tree_from_lxml(doc.getroot()))
    return errors, warnings, schema_msgs


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m prlxml.nydol", description="New York DOL certified payroll bulk upload XML")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("convert", help="CSV to NYS DOL XML")
    c.add_argument("csv")
    c.add_argument("-o", "--out")
    k = sub.add_parser("check", help="check a NYS DOL XML file")
    k.add_argument("xml")
    k.add_argument("--schemas", default="schemas/nydol")
    a = ap.parse_args(argv)
    if a.cmd == "convert":
        try:
            xml = convert_csv(decode_csv_bytes(Path(a.csv).read_bytes()))
        except ConvertError as e:
            print(f"convert stopped: {e}", file=sys.stderr)
            return 2
        out = Path(a.out) if a.out else Path(a.csv).with_suffix(".xml")
        out.write_text(xml, encoding="utf-8", newline="\n")
        print(f"wrote {out}")
        return 0
    errors, warnings, schema_msgs = check_file(Path(a.xml), Path(a.schemas))
    if schema_msgs is None:
        print(f"SKIP schema: {NY_XSD} not found in {a.schemas}. Run: python -m prlxml.fetch_schemas ny")
    for m in schema_msgs or []:
        print(f"SCHEMA {m}")
    for m in errors:
        print(f"RULE {m}")
    for m in warnings:
        print(f"WARN {m}")
    bad = bool(errors or schema_msgs)
    print("FAIL" if bad else "OK")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
