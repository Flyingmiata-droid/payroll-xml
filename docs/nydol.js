/* New York State DOL certified payroll bulk upload XML: convert a CSV, and check a file.
   The browser twin of prlxml/nydol.py. tests/test_nydol.py holds the two to the same answers.
   Uses parseCsv and decodeCsvBytes from prlxml.js. Sends nothing anywhere. MIT license. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./prlxml.js"));
  } else {
    root.nydol = factory(root.prlxml);
  }
})(typeof self !== "undefined" ? self : this, function (prlxml) {
  "use strict";

  var ConvertError = prlxml.ConvertError;

  var STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
    CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
    FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
    IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
    ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
    MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
    NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
    PA: "Pennsylvania", PR: "Puerto Rico", RI: "Rhode Island", SC: "South Carolina",
    SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
    VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming"
  };
  function stateKey(s) { return s.toUpperCase().split(".").join(""); }
  function hasState(s) { return Object.prototype.hasOwnProperty.call(STATES, stateKey(s)); }

  var FRINGES = [
    ["health", "Health/Welfare"],
    ["vacation", "Vacation/Holiday"],
    ["training", "Apprenticeship/Training"],
    ["pension", "Pension"],
    ["other", "Other Benefit (Type)"]
  ];
  var OTHER = "Other Benefit (Type)";
  var REQUIRED = ["prc_number", "week_ending", "last_name", "first_name", "address1", "city", "state", "zip",
    "gross_earnings", "net_wages", "work_category", "st_rate", "ot_rate", "work_date", "st_hours", "ot_hours"];
  var EMPLOYEE_COLS = ["middle_name", "ssn_last4", "date_of_birth", "apprentice", "address1", "address2", "city", "state",
    "zip", "country", "gross_earnings", "net_wages", "deductions"];
  var CLASS_COLS = ["st_rate", "ot_rate"];
  FRINGES.forEach(function (f) { CLASS_COLS.push(f[0], f[0] + "_ot"); });
  CLASS_COLS.push("other_explanation");
  // The state schema's limits. Characters for text, hundredths for numbers.
  var TEXT_LIMITS = [
    ["first_name", 45], ["middle_name", 45], ["last_name", 45], ["address1", 42], ["address2", 42], ["city", 40],
    ["country", 50], ["work_category", 300], ["other_explanation", 256]
  ];
  var NUM_LIMITS = [["gross_earnings", 99999999n], ["net_wages", 99999999n], ["st_rate", 99999n], ["ot_rate", 99999n]];
  FRINGES.forEach(function (f) { NUM_LIMITS.push([f[0], 1000000n], [f[0] + "_ot", 1000000n]); });
  var DEDUCTION_TYPE_MAX = 50;
  var DEDUCTION_MAX = 999999n;
  var TRUE_WORDS = ["y", "yes", "true", "1"];
  var FALSE_WORDS = ["", "n", "no", "false", "0"];

  // ---------- numbers: BigInt hundredths ----------
  var DEC = /^([+-]?)([0-9]*)(?:\.([0-9]*))?$/;

  function hundredths(s) {
    if (s === null || s === undefined) return null;
    s = s.trim();
    var m = DEC.exec(s);
    if (!m || !(m[2] || m[3]) || s.length > 15) return null;
    var frac = (m[3] || "").replace(/0+$/, "");
    if (frac.length > 2) return null;
    var v = BigInt(m[2] || "0") * 100n + BigInt((frac + "00").slice(0, 2));
    return m[1] === "-" ? -v : v;
  }

  function money(n) {
    var sign = n < 0n ? "-" : "";
    if (n < 0n) n = -n;
    var c = String(n % 100n);
    return sign + String(n / 100n) + "." + (c.length < 2 ? "0" + c : c);
  }

  // ---------- dates as day numbers ----------
  var ISO = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
  var US = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/;

  function mkDay(y, mo, d) {
    if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
    var t = new Date(0);
    t.setUTCFullYear(y, mo - 1, d);
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return Math.round(t.getTime() / 86400000);
  }

  function parseDay(s) {
    s = (s || "").trim();
    var m = ISO.exec(s);
    if (m) return mkDay(+m[1], +m[2], +m[3]);
    m = US.exec(s);
    if (m) return mkDay(+m[3], +m[1], +m[2]);
    return null;
  }

  function iso(n) {
    var t = new Date(n * 86400000);
    var y = String(t.getUTCFullYear());
    while (y.length < 4) y = "0" + y;
    var mo = String(t.getUTCMonth() + 1), d = String(t.getUTCDate());
    return y + "-" + (mo.length < 2 ? "0" + mo : mo) + "-" + (d.length < 2 ? "0" + d : d);
  }

  function cpLen(s) { return Array.from(s).length; }

  // ---------- convert ----------
  function rows(text) {
    text = text.replace(/^(?:\r\n|\r|\n)+/, "");
    var table = prlxml.parseCsv(text);
    if (!table.length) throw new ConvertError("the file is empty");
    var head = table[0].map(function (h) { return h.trim().toLowerCase(); });
    var missing = REQUIRED.filter(function (c) { return head.indexOf(c) < 0; });
    if (missing.length) throw new ConvertError("missing columns: " + missing.join(", "));
    var out = [];
    for (var i = 1; i < table.length; i++) {
      var cells = table[i];
      if (!cells.some(function (c) { return c.trim(); })) continue;
      var row = {};
      head.forEach(function (h, j) {
        // like Python's dict: a repeated column name keeps the last cell
        row[h] = j < cells.length ? cells[j].trim() : "";
      });
      row._line = i + 1;
      out.push(row);
    }
    if (!out.length) throw new ConvertError("no data rows");
    return out;
  }

  function get(row, col) { return Object.prototype.hasOwnProperty.call(row, col) ? row[col] : ""; }

  function needNum(row, col) {
    var v = get(row, col);
    var n = hundredths(v);
    if (n === null) throw new ConvertError("row " + row._line + ": " + col + " '" + v + "' is not a number with at most 2 decimals");
    if (n < 0n) throw new ConvertError("row " + row._line + ": " + col + " is below 0");
    return n;
  }

  function ssn4(row) {
    var digits = get(row, "ssn_last4").replace(/[\s-]/g, "");
    if (!digits) return "";
    if (!/^[0-9]+$/.test(digits) || (digits.length !== 4 && digits.length !== 9)) {
      throw new ConvertError("row " + row._line + ": ssn_last4 must be the last 4 digits (a full 9 digit SSN is cut to its last 4)");
    }
    return digits.slice(-4);
  }

  function zip(row) {
    var v = get(row, "zip");
    var m = /^([0-9]{3,5})(?:-?([0-9]{4}))?$/.exec(v);
    if (!m) throw new ConvertError("row " + row._line + ": zip '" + v + "' is not a 5 digit ZIP or ZIP+4");
    var z = m[1];
    while (z.length < 5) z = "0" + z;
    return [z, m[2] || ""];
  }

  function state(row) {
    var v = get(row, "state");
    return hasState(v) ? STATES[stateKey(v)] : v;
  }

  function apprentice(row) {
    var v = get(row, "apprentice").toLowerCase();
    if (TRUE_WORDS.indexOf(v) >= 0) return "true";
    if (FALSE_WORDS.indexOf(v) >= 0) return "false";
    throw new ConvertError("row " + row._line + ": apprentice '" + get(row, "apprentice") + "' must be Y or N");
  }

  function deductions(row) {
    var out = [];
    get(row, "deductions").split(";").map(function (p) { return p.trim(); }).filter(Boolean).forEach(function (part) {
      var at = part.lastIndexOf(":");
      if (at < 0) throw new ConvertError("row " + row._line + ": deduction '" + part + "' must be written type:amount");
      var t = part.slice(0, at).trim();
      var n = hundredths(part.slice(at + 1));
      if (!t || n === null || n < 0n) throw new ConvertError("row " + row._line + ": deduction '" + part + "' must be written type:amount");
      if (cpLen(t) > DEDUCTION_TYPE_MAX) throw new ConvertError("row " + row._line + ": deduction type '" + t + "' is " + cpLen(t) + " characters; the state takes at most " + DEDUCTION_TYPE_MAX);
      if (n > DEDUCTION_MAX) throw new ConvertError("row " + row._line + ": deduction '" + t + "' is " + money(n) + "; the state takes at most " + money(DEDUCTION_MAX));
      out.push([t, n]);
    });
    if (out.length > 10) throw new ConvertError("row " + row._line + ": the state takes at most 10 deductions per worker");
    return out;
  }

  function fringes(row) {
    var out = [];
    FRINGES.forEach(function (f) {
      var col = f[0], typ = f[1];
      var st = hundredths(get(row, col) || "0");
      var otRaw = get(row, col + "_ot");
      var ot = otRaw ? hundredths(otRaw) : st;
      if (st === null || ot === null || st < 0n || ot < 0n) {
        throw new ConvertError("row " + row._line + ": " + col + " fringe rate must be a number with at most 2 decimals");
      }
      if (st === 0n && ot === 0n) return;
      var expl = typ === OTHER ? get(row, "other_explanation") : "";
      if (typ === OTHER && !expl) {
        throw new ConvertError("row " + row._line + ": an other fringe needs other_explanation (the state rejects it without one)");
      }
      out.push([typ, st, ot, expl]);
    });
    return out;
  }

  function limits(row) {
    TEXT_LIMITS.forEach(function (l) {
      var v = get(row, l[0]);
      if (cpLen(v) > l[1]) throw new ConvertError("row " + row._line + ": " + l[0] + " is " + cpLen(v) + " characters; the state takes at most " + l[1]);
    });
    var st = state(row);
    if (cpLen(st) > 50) throw new ConvertError("row " + row._line + ": state is " + cpLen(st) + " characters; the state takes at most 50");
    NUM_LIMITS.forEach(function (l) {
      var n = hundredths(get(row, l[0]));
      if (n !== null && n > l[1]) throw new ConvertError("row " + row._line + ": " + l[0] + " is " + money(n) + "; the state takes at most " + money(l[1]));
    });
  }

  function same(first, row, cols, what) {
    cols.forEach(function (c) {
      if (get(first, c) !== get(row, c)) {
        throw new ConvertError("row " + row._line + ": " + c + " '" + get(row, c) + "' differs from row " + first._line + " ('" + get(first, c) + "') for " + what);
      }
    });
  }

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function convertCsv(text) {
    var rs = rows(text);
    var first = rs[0];
    var prc = first.prc_number;
    if (cpLen(prc) !== 10) throw new ConvertError("row " + first._line + ": prc_number '" + prc + "' must be 10 characters");
    var end = parseDay(first.week_ending);
    if (end === null) throw new ConvertError("row " + first._line + ": week_ending '" + first.week_ending + "' is not a date");
    var start = end - 6;
    rs.forEach(function (r) {
      if (r.prc_number !== prc) throw new ConvertError("row " + r._line + ": a file holds one project; prc_number differs from row " + first._line);
      if (parseDay(r.week_ending) !== end) throw new ConvertError("row " + r._line + ": a file holds one week; week_ending differs from row " + first._line);
    });

    var people = new Map();
    rs.forEach(function (r) {
      ["last_name", "first_name", "work_category", "address1", "city", "state"].forEach(function (c) {
        if (!get(r, c)) throw new ConvertError("row " + r._line + ": " + c + " is blank");
      });
      limits(r);
      var s4 = ssn4(r);
      var dob = get(r, "date_of_birth");
      if (dob && parseDay(dob) === null) throw new ConvertError("row " + r._line + ": date_of_birth '" + dob + "' is not a date");
      if (dob) dob = r.date_of_birth = iso(parseDay(dob)); // 4/17/1999 and 1999-04-17 are one person
      if (!!s4 === !!dob) throw new ConvertError("row " + r._line + ": give ssn_last4 or date_of_birth, one of them, not both and not neither");
      var key = JSON.stringify([r.last_name.toLowerCase(), r.first_name.toLowerCase(), get(r, "middle_name").toLowerCase(), s4, dob]);
      var p = people.get(key);
      var who = r.first_name + " " + r.last_name;
      if (!p) {
        p = { row: r, classes: new Map() };
        people.set(key, p);
      } else {
        same(p.row, r, EMPLOYEE_COLS, who);
      }
      var cat = r.work_category;
      var k = p.classes.get(cat);
      if (!k) {
        k = { row: r, days: new Map() };
        p.classes.set(cat, k);
      } else {
        same(k.row, r, CLASS_COLS, who + ", " + cat);
      }
      var d = parseDay(r.work_date);
      if (d === null) throw new ConvertError("row " + r._line + ": work_date '" + r.work_date + "' is not a date");
      if (d < start || d > end) throw new ConvertError("row " + r._line + ": work_date " + iso(d) + " is outside the week " + iso(start) + " to " + iso(end));
      if (k.days.has(d)) throw new ConvertError("row " + r._line + ": " + iso(d) + " is listed twice for " + who + ", " + cat + "; put the hours on one row");
      var st = needNum(r, "st_hours");
      var ot = needNum(r, "ot_hours");
      if (st > 2400n || ot > 2400n) throw new ConvertError("row " + r._line + ": the state takes at most 24 hours in one day");
      k.days.set(d, [st, ot]);
    });
    if (people.size > 500) throw new ConvertError("the state takes at most 500 workers in one file; split it");

    var o = ['<?xml version="1.0" encoding="UTF-8"?>'];
    o.push('<ProjectRollup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="NYDOL_CertPayroll.xsd">');
    o.push("    <prcNumber>" + esc(prc) + "</prcNumber>");
    o.push("    <weekEndingDate>" + iso(end) + "T00:00:00.000Z</weekEndingDate>");
    o.push("    <employeeWorkWeeks>");
    function pad(n) { return new Array(4 * n + 1).join(" "); }
    function el(depth, tag, val) { o.push(pad(depth) + "<" + tag + ">" + esc(val) + "</" + tag + ">"); }
    people.forEach(function (p) {
      var r = p.row;
      var z = zip(r);
      var ded = deductions(r);
      var gross = needNum(r, "gross_earnings");
      var net = needNum(r, "net_wages");
      o.push("        <employeeWorkWeek>");
      o.push("            <employee>");
      el(4, "firstName", r.first_name);
      if (get(r, "middle_name")) el(4, "middleName", r.middle_name);
      el(4, "lastName", r.last_name);
      if (get(r, "date_of_birth")) el(4, "dateOfBirth", iso(parseDay(r.date_of_birth)));
      else el(4, "ssnLast4", ssn4(r));
      el(4, "nysRegisteredApprentice", apprentice(r));
      o.push("                <address>");
      el(5, "address1", r.address1);
      if (get(r, "address2")) el(5, "address2", r.address2);
      el(5, "city", r.city);
      el(5, "state", state(r));
      el(5, "postalCode", z[0]);
      if (z[1]) el(5, "postalCodeExt", z[1]);
      el(5, "country", get(r, "country") || "United States");
      o.push("                </address>");
      o.push("            </employee>");
      el(3, "deductionsGrossEarnings", money(gross));
      el(3, "netWages", money(net));
      o.push("            <workWeeks>");
      var supps = [];
      p.classes.forEach(function (k, cat) {
        var kr = k.row;
        o.push("                <workWeek>");
        el(5, "workCategory", cat);
        el(5, "stHourlyRate", money(needNum(kr, "st_rate")));
        el(5, "otHourlyRate", money(needNum(kr, "ot_rate")));
        o.push("                    <days>");
        Array.from(k.days.keys()).sort(function (a, b) { return a - b; }).forEach(function (d) {
          var h = k.days.get(d);
          o.push("                        <day>");
          el(7, "day", iso(d));
          el(7, "standardTimeHours", money(h[0]));
          el(7, "overTimeHours", money(h[1]));
          o.push("                        </day>");
        });
        o.push("                    </days>");
        o.push("                </workWeek>");
        fringes(kr).forEach(function (f) { supps.push([cat].concat(f)); });
      });
      o.push("            </workWeeks>");
      if (ded.length) {
        o.push("            <deductions>");
        ded.forEach(function (d) {
          o.push("                <deduction>");
          el(5, "type", d[0]);
          el(5, "amount", money(d[1]));
          o.push("                </deduction>");
        });
        o.push("            </deductions>");
      } else {
        o.push("            <deductions/>");
      }
      if (supps.length > 50) throw new ConvertError(r.first_name + " " + r.last_name + ": the state takes at most 50 fringe lines per worker");
      if (supps.length) {
        o.push("            <supplementalPayments>");
        supps.forEach(function (s) {
          o.push("                <supplementalPayment>");
          el(5, "type", s[1]);
          el(5, "workCategory", s[0]);
          if (s[4]) el(5, "explanation", s[4]);
          el(5, "standardHourlyRate", money(s[2]));
          el(5, "overtimeHourlyRate", money(s[3]));
          o.push("                </supplementalPayment>");
        });
        o.push("            </supplementalPayments>");
      } else {
        o.push("            <supplementalPayments/>");
      }
      o.push("        </employeeWorkWeek>");
    });
    o.push("    </employeeWorkWeeks>");
    o.push("</ProjectRollup>");
    return o.join("\n") + "\n";
  }

  // ---------- check ----------
  function Node(tag, text, kids) { this.tag = tag; this.text = text; this.kids = kids; }
  Node.prototype.all = function (tag) { return this.kids.filter(function (k) { return k.tag === tag; }); };
  Node.prototype.one = function (tag) {
    for (var i = 0; i < this.kids.length; i++) if (this.kids[i].tag === tag) return this.kids[i];
    return null;
  };
  Node.prototype.val = function (tag) {
    var k = this.one(tag);
    return k ? k.text.trim() : null;
  };

  function treeFromDom(el) {
    var kids = [];
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) kids.push(treeFromDom(c));
    return new Node(el.localName || el.nodeName, kids.length ? "" : (el.textContent || ""), kids);
  }

  function lenErr(errors, who, tag, v, most) {
    if (v !== null && cpLen(v) > most) errors.push(who + ": " + tag + " is " + cpLen(v) + " characters; the state takes at most " + most);
  }

  function maxErr(errors, who, tag, n, most) {
    if (n !== null && n > most) errors.push(who + ": " + tag + " is " + money(n) + "; the state takes at most " + money(most));
  }

  function ruleCheck(root) {
    var errors = [], warnings = [];
    if (root.tag !== "ProjectRollup") return { errors: ["the top element is " + root.tag + ", not ProjectRollup"], warnings: [] };
    var prc = root.val("prcNumber");
    if (prc !== null && cpLen(prc) !== 10) errors.push("prcNumber '" + prc + "' must be 10 characters");
    var wk = root.val("weekEndingDate");
    var end = null;
    if (wk !== null) {
      var m = /^([0-9]{4}-[0-9]{2}-[0-9]{2})(T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)?$/.exec(wk);
      end = m ? parseDay(m[1]) : null;
      if (m && !m[2] && end !== null) errors.push("weekEndingDate needs the time on it: write " + m[1] + "T00:00:00.000Z");
      else if (end === null) errors.push("weekEndingDate '" + wk + "' is not a date like 2025-08-03T00:00:00.000Z");
    }
    var start = end !== null ? end - 6 : null;
    var wrap = root.one("employeeWorkWeeks");
    var ews = wrap ? wrap.all("employeeWorkWeek") : [];
    var seen = new Map();
    ews.forEach(function (ew, idx) {
      var i = idx + 1;
      var emp = ew.one("employee");
      if (!emp) return;
      var name = [emp.val("firstName"), emp.val("lastName")].filter(function (x) { return x; }).join(" ");
      var who = "employee " + i + " (" + name + ")";
      var s4 = emp.val("ssnLast4"), dob = emp.val("dateOfBirth");
      if (s4 && dob) errors.push(who + ": has both ssnLast4 and dateOfBirth; the state takes one, not both");
      if (!s4 && !dob) errors.push(who + ": needs ssnLast4 or dateOfBirth");
      var key = JSON.stringify([(emp.val("firstName") || "").toLowerCase(), (emp.val("lastName") || "").toLowerCase(), s4 || "", dob || ""]);
      if (seen.has(key)) {
        errors.push(who + ": same worker as employee " + seen.get(key) + "; the state rejects duplicate employees (put both classifications under one employee)");
      } else {
        seen.set(key, i);
      }
      [["firstName", 45], ["middleName", 45], ["lastName", 45]].forEach(function (l) { lenErr(errors, who, l[0], emp.val(l[0]), l[1]); });
      var appr = emp.val("nysRegisteredApprentice");
      if (appr !== null && ["true", "false", "1", "0"].indexOf(appr) < 0) {
        errors.push(who + ": nysRegisteredApprentice is '" + appr + "'; write true or false (the schema note says Y or N, but the schema only takes true or false)");
      }
      var addr = emp.one("address");
      if (addr) {
        var st = addr.val("state");
        if (st && hasState(st)) errors.push(who + ": state '" + st + "' must be the full name (" + STATES[stateKey(st)] + ")");
        [["address1", 42], ["address2", 42], ["city", 40], ["state", 50], ["country", 50]].forEach(function (l) { lenErr(errors, who, l[0], addr.val(l[0]), l[1]); });
        if (!addr.one("country")) {
          errors.push(who + ": address has no country; the schema requires it even though the state's guide page marks it optional (use United States)");
        }
      }
      if (dob) {
        var b = parseDay(dob);
        if (b !== null && end !== null && (b > end - 365 * 14 || b < end - 365 * 100)) {
          warnings.push(who + ": dateOfBirth " + dob + " gives an age under 14 or over 100");
        }
      }
      if (ew.one("deductionGrossEarnings")) {
        errors.push(who + ": the element is deductionsGrossEarnings, with an s; the state's guide page spells it without");
      }
      var gross = hundredths(ew.val("deductionsGrossEarnings"));
      var net = hundredths(ew.val("netWages"));
      [["deductionsGrossEarnings", gross], ["netWages", net]].forEach(function (tv) {
        if (tv[1] !== null && tv[1] < 0n) errors.push(who + ": " + tv[0] + " is below 0");
        maxErr(errors, who, tv[0], tv[1], 99999999n);
      });
      var cats = new Map(), totalHours = 0n, earned = 0n;
      var wws = ew.one("workWeeks");
      (wws ? wws.all("workWeek") : []).forEach(function (w) {
        var cat = w.val("workCategory") || "";
        var here = who + ", " + cat;
        if (cats.has(cat)) warnings.push(here + ": listed twice; one workWeek per classification");
        cats.set(cat, true);
        var str = hundredths(w.val("stHourlyRate"));
        var otr = hundredths(w.val("otHourlyRate"));
        lenErr(errors, who, "workCategory", cat, 300);
        [["stHourlyRate", str], ["otHourlyRate", otr]].forEach(function (tv) {
          if (tv[1] !== null && tv[1] < 0n) errors.push(here + ": " + tv[0] + " is below 0");
          maxErr(errors, here, tv[0], tv[1], 99999n);
        });
        if (str !== null && str === 0n) errors.push(here + ": stHourlyRate is 0.00");
        var days = w.one("days");
        var dates = new Map(), otTotal = 0n;
        (days ? days.all("day") : []).forEach(function (d) {
          var dv = d.val("day");
          var dd = dv && ISO.test(dv) ? parseDay(dv) : null;
          var sth = hundredths(d.val("standardTimeHours")), oth = hundredths(d.val("overTimeHours"));
          [["standardTimeHours", sth], ["overTimeHours", oth]].forEach(function (tv) {
            if (tv[1] !== null && tv[1] < 0n) errors.push(here + ", " + dv + ": " + tv[0] + " is below 0");
          });
          if (dd !== null && start !== null && (dd < start || dd > end)) {
            errors.push(here + ": day " + dv + " is outside the week " + iso(start) + " to " + iso(end));
          }
          if (dd !== null) {
            if (dates.has(dd)) warnings.push(here + ": day " + dv + " is listed twice");
            dates.set(dd, true);
          }
          if (sth !== null && oth !== null && sth + oth > 2400n) warnings.push(here + ", " + dv + ": more than 24 hours in one day");
          if (sth !== null && sth > 0n) {
            totalHours += sth;
            if (str !== null && str > 0n) earned += sth * str;
          }
          if (oth !== null && oth > 0n) {
            totalHours += oth;
            otTotal += oth;
            if (otr !== null && otr > 0n) earned += oth * otr;
          }
        });
        if (otTotal > 0n && otr !== null && str !== null && otr < str) {
          warnings.push(here + ": otHourlyRate " + money(otr) + " is below stHourlyRate " + money(str));
        }
      });
      if (totalHours === 0n) warnings.push(who + ": no hours this week");
      if (gross !== null && gross * 100n < earned) {
        warnings.push(who + ": deductionsGrossEarnings " + money(gross) + " is below the hours times the rates (" + money(earned / 100n) + ")");
      }
      var dwrap = ew.one("deductions");
      var dsum = 0n, dok = true;
      (dwrap ? dwrap.all("deduction") : []).forEach(function (d) {
        lenErr(errors, who, "deduction type", d.val("type"), DEDUCTION_TYPE_MAX);
        var a = hundredths(d.val("amount"));
        maxErr(errors, who, "deduction " + (d.val("type") || ""), a, DEDUCTION_MAX);
        if (a === null) dok = false;
        else dsum += a;
      });
      if (dok && gross !== null && net !== null && gross - dsum !== net) {
        warnings.push(who + ": deductionsGrossEarnings " + money(gross) + " minus deductions " + money(dsum) + " is " + money(gross - dsum) + ", but netWages is " + money(net));
      }
      var swrap = ew.one("supplementalPayments");
      (swrap ? swrap.all("supplementalPayment") : []).forEach(function (s) {
        var typ = s.val("type"), expl = s.val("explanation"), scat = s.val("workCategory");
        lenErr(errors, who, "explanation", expl, 256);
        ["standardHourlyRate", "overtimeHourlyRate"].forEach(function (tag) {
          maxErr(errors, who, (typ || "") + " " + tag, hundredths(s.val(tag)), 1000000n);
        });
        if (typ === OTHER && !expl) errors.push(who + ": an " + OTHER + " fringe needs an explanation");
        if (typ !== null && typ !== OTHER && expl) errors.push(who + ": a " + typ + " fringe has an explanation; the state takes one only on " + OTHER);
        if (scat !== null && !cats.has(scat)) warnings.push(who + ": fringe for '" + scat + "', which is not one of this worker's classifications");
      });
    });
    return { errors: errors, warnings: warnings };
  }

  // text: the XML as a string. Parser: the DOMParser class (window.DOMParser, or @xmldom/xmldom 0.8 under Node).
  function checkXml(text, Parser) {
    var problems = [];
    var note = function (m) { problems.push(String(m)); };
    var doc;
    try {
      doc = new Parser({ errorHandler: { warning: function () {}, error: note, fatalError: note } }).parseFromString(text, "application/xml");
    } catch (e) {
      return { errors: ["not well-formed XML: " + e.message], warnings: [] };
    }
    var bad = doc && doc.getElementsByTagName ? doc.getElementsByTagName("parsererror") : [];
    if (problems.length || !doc || !doc.documentElement || bad.length) {
      return { errors: ["not well-formed XML: " + (problems[0] || (bad.length ? bad[0].textContent : "no root element"))], warnings: [] };
    }
    return ruleCheck(treeFromDom(doc.documentElement));
  }

  // samples/ny/week1.csv; tests/test_nydol.py checks the two match.
  var SAMPLE_CSV = [
    "prc_number,week_ending,last_name,first_name,middle_name,ssn_last4,date_of_birth,apprentice,address1,address2,city,state,zip,country,gross_earnings,net_wages,deductions,work_category,st_rate,ot_rate,health,pension,training,other,other_explanation,work_date,st_hours,ot_hours",
    "2025001234,2026-10-04,Lopez,Maria,A,4821,,N,41 Elm St,,Albany,NY,12207-0002,,1935.00,1491.97,Federal Tax:210.00;State Tax:85.00;FICA:119.97;Medicare:28.06,Laborer - Building,45.00,67.50,12.50,9.75,0.80,,,2026-09-28,8,0",
    "2025001234,2026-10-04,Lopez,Maria,A,4821,,N,41 Elm St,,Albany,NY,12207-0002,,1935.00,1491.97,Federal Tax:210.00;State Tax:85.00;FICA:119.97;Medicare:28.06,Laborer - Building,45.00,67.50,12.50,9.75,0.80,,,2026-09-29,8,0",
    "2025001234,2026-10-04,Lopez,Maria,A,4821,,N,41 Elm St,,Albany,NY,12207-0002,,1935.00,1491.97,Federal Tax:210.00;State Tax:85.00;FICA:119.97;Medicare:28.06,Laborer - Building,45.00,67.50,12.50,9.75,0.80,,,2026-09-30,8,0",
    "2025001234,2026-10-04,Lopez,Maria,A,4821,,N,41 Elm St,,Albany,NY,12207-0002,,1935.00,1491.97,Federal Tax:210.00;State Tax:85.00;FICA:119.97;Medicare:28.06,Laborer - Building,45.00,67.50,12.50,9.75,0.80,,,2026-10-01,8,0",
    "2025001234,2026-10-04,Lopez,Maria,A,4821,,N,41 Elm St,,Albany,NY,12207-0002,,1935.00,1491.97,Federal Tax:210.00;State Tax:85.00;FICA:119.97;Medicare:28.06,Laborer - Building,45.00,67.50,12.50,9.75,0.80,,,2026-10-02,8,2",
    "2025001234,2026-10-04,O'Neill,James,,,1999-04-17,Y,9 River Rd,Apt 2,Fort Lee,NJ,07024,,1612.00,1278.69,Federal Tax:150.00;State Tax:60.00;FICA:99.94;Medicare:23.37,Carpenter - Building,38.00,57.00,11.00,,,1.50,Annuity,2026-09-28,8,0",
    "2025001234,2026-10-04,O'Neill,James,,,1999-04-17,Y,9 River Rd,Apt 2,Fort Lee,NJ,07024,,1612.00,1278.69,Federal Tax:150.00;State Tax:60.00;FICA:99.94;Medicare:23.37,Carpenter - Building,38.00,57.00,11.00,,,1.50,Annuity,2026-09-29,8,0",
    "2025001234,2026-10-04,O'Neill,James,,,1999-04-17,Y,9 River Rd,Apt 2,Fort Lee,NJ,07024,,1612.00,1278.69,Federal Tax:150.00;State Tax:60.00;FICA:99.94;Medicare:23.37,Carpenter - Building,38.00,57.00,11.00,,,1.50,Annuity,2026-09-30,8,0",
    "2025001234,2026-10-04,O'Neill,James,,,1999-04-17,Y,9 River Rd,Apt 2,Fort Lee,NJ,07024,,1612.00,1278.69,Federal Tax:150.00;State Tax:60.00;FICA:99.94;Medicare:23.37,Carpenter - Heavy and Highway,40.00,60.00,11.00,,,,,2026-10-01,8,1",
    "2025001234,2026-10-04,O'Neill,James,,,1999-04-17,Y,9 River Rd,Apt 2,Fort Lee,NJ,07024,,1612.00,1278.69,Federal Tax:150.00;State Tax:60.00;FICA:99.94;Medicare:23.37,Carpenter - Heavy and Highway,40.00,60.00,11.00,,,,,2026-10-02,8,0"
  ].join("\n") + "\n";

  return {
    ConvertError: ConvertError,
    REQUIRED: REQUIRED,
    hundredths: hundredths,
    convertCsv: convertCsv,
    checkXml: checkXml,
    ruleCheck: ruleCheck,
    SAMPLE_CSV: SAMPLE_CSV,
    TEMPLATE_CSV: SAMPLE_CSV.split("\n")[0] + "\n"
  };
});
