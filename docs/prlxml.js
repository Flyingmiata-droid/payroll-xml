/*
  payroll-xml for the browser. MIT license.
  Same convert and check as the Python tool in prlxml/, ported line for line.
  Nothing here talks to a network. The file you give it stays in the tab.
  tests/test_web.py and tests/web_parity.js hold the two in step.
*/
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.prlxml = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PRL_NS = "http://www.transxml.net/schema/prl/1.2";
  var TXL_NS = "http://www.transxml.net/schema/txl/1.0";

  var HEADER_COLS = ["vendor_id", "contract_id", "payroll_number", "period_begin", "period_end", "fringe_type"];
  var EMP_COLS = ["last_name", "first_name", "middle_initial", "ssn", "employee_id", "gender", "ethnicity"];
  var LABOR_COLS = ["craft_code", "labor_class", "project_id", "apprentice", "st_rate", "ot_rate"];
  var DAY_COLS = ["work_date", "st_hours", "ot_hours"];
  var TOTAL_COLS = ["gross_pay", "total_deductions", "net_pay", "fica", "federal_tax", "state_tax", "medicare", "other_deductions"];
  var REQUIRED = [].concat(HEADER_COLS, EMP_COLS, LABOR_COLS, DAY_COLS, TOTAL_COLS);
  // Optional columns. Leave them out or blank when they do not apply.
  // project_gross: pay for this contract and project only. Blank means rates times hours plus lump_sum.
  // lump_sum: cash fringe or other cash paid on this line. apprentice_id, apprentice_pct: needed when apprentice is yes.
  // Fringe paid to plans (Plan Funds): an hourly rate per program type, and fringe_benefits, the fringe paid on this line.
  var FRINGE_RATE_COLS = [
    ["health_rate", "healthWellfareRate"], ["vacation_rate", "vacationHolidayRate"], ["apprenticeship_rate", "apprenticeshipFundRate"],
    ["pension_rate", "pensionRate"], ["other1_rate", "other1Rate"], ["other2_rate", "other2Rate"]
  ];
  var LINE_OPTIONAL = ["project_gross", "lump_sum", "apprentice_id", "apprentice_pct"]
    .concat(FRINGE_RATE_COLS.map(function (f) { return f[0]; }), ["fringe_benefits"]);
  // One fringe benefit program per type, same on every row: name | account ID | trustee | phone, and | class (needed for other 1 and 2).
  var PROGRAM_COLS = [
    ["health_program", "Fringe Health/Welfare"], ["vacation_program", "Fringe Vacation/Holiday"],
    ["apprenticeship_program", "Fringe Apprenticeship Fund"], ["pension_program", "Fringe Pension"],
    ["other1_program", "Fringe Other 1"], ["other2_program", "Fringe Other 2"]
  ];
  var OPTIONAL = LINE_OPTIONAL.concat(PROGRAM_COLS.map(function (p) { return p[0]; }));

  function ConvertError(message) {
    this.name = "ConvertError";
    this.message = message;
  }
  ConvertError.prototype = Object.create(Error.prototype);
  ConvertError.prototype.constructor = ConvertError;

  // ---- Python repr for strings, so messages read the same in both tools ----
  var NONPRINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}]/u;
  var SPACE_SEP = /\p{Zs}/u;

  function hex(n, width) {
    var h = n.toString(16);
    while (h.length < width) h = "0" + h;
    return h;
  }

  function pyRepr(s) {
    if (s === null || s === undefined) return "None";
    s = String(s);
    var q = s.indexOf("'") >= 0 && s.indexOf('"') < 0 ? '"' : "'";
    var out = q;
    for (var ch of s) {
      var code = ch.codePointAt(0);
      if (ch === "\\") out += "\\\\";
      else if (ch === q) out += "\\" + q;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch !== " " && (SPACE_SEP.test(ch) || NONPRINT.test(ch))) {
        if (code < 0x100) out += "\\x" + hex(code, 2);
        else if (code < 0x10000) out += "\\u" + hex(code, 4);
        else out += "\\U" + hex(code, 8);
      } else out += ch;
    }
    return out + q;
  }

  function pyListRepr(arr) {
    return "[" + arr.map(pyRepr).join(", ") + "]";
  }

  function cpLen(s) {
    return Array.from(s).length;
  }

  // ---- exact decimals (BigInt mantissa, scale), like Python's Decimal ----
  var DEC_RE = /^([+-])?(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:[eE]([+-]?[0-9]+))?$/;

  function parseDecimal(value) {
    if (value === null || value === undefined) return null;
    var m = DEC_RE.exec(String(value).trim());
    if (!m) return null;
    var intPart = m[2] || "";
    var frac = m[3] !== undefined ? m[3] : (m[4] || "");
    var exp = m[5] ? parseInt(m[5], 10) : 0;
    var mant = BigInt((intPart + frac) || "0");
    var scale = frac.length - exp;
    // Same limits as the Python tool: at most 100 digits, exponent within 100.
    if (String(mant).length > 100 || scale > 100 || scale < -100) return null;
    if (scale < 0) {
      mant = mant * (10n ** BigInt(-scale));
      scale = 0;
    }
    if (m[1] === "-") mant = -mant;
    return { m: mant, s: scale };
  }

  function align(a, b) {
    var s = Math.max(a.s, b.s);
    return [a.m * (10n ** BigInt(s - a.s)), b.m * (10n ** BigInt(s - b.s)), s];
  }

  function decAdd(a, b) {
    var x = align(a, b);
    return { m: x[0] + x[1], s: x[2] };
  }

  function decSub(a, b) {
    var x = align(a, b);
    return { m: x[0] - x[1], s: x[2] };
  }

  function decEq(a, b) {
    var x = align(a, b);
    return x[0] === x[1];
  }

  // Round to two places, half to even (Python's default), return cents.
  function toCents(d) {
    if (d.s <= 2) return d.m * (10n ** BigInt(2 - d.s));
    var div = 10n ** BigInt(d.s - 2);
    var neg = d.m < 0n;
    var mag = neg ? -d.m : d.m;
    var q = mag / div;
    var r = mag % div;
    if (2n * r > div || (2n * r === div && q % 2n === 1n)) q += 1n;
    return neg ? -q : q;
  }

  // Round to k places, half to even. Returns the integer count of 10^-k units.
  function toScale(d, k) {
    if (d.s <= k) return d.m * (10n ** BigInt(k - d.s));
    var div = 10n ** BigInt(d.s - k);
    var neg = d.m < 0n;
    var mag = neg ? -d.m : d.m;
    var q = mag / div;
    var r = mag % div;
    if (2n * r > div || (2n * r === div && q % 2n === 1n)) q += 1n;
    return neg ? -q : q;
  }

  function fmtScaled(n, k) {
    var neg = n < 0n;
    var mag = neg ? -n : n;
    var unit = 10n ** BigInt(k);
    var frac = String(mag % unit);
    while (frac.length < k) frac = "0" + frac;
    return (neg ? "-" : "") + String(mag / unit) + "." + frac;
  }

  function fmtCents(c) {
    var neg = c < 0n;
    var mag = neg ? -c : c;
    var frac = String(mag % 100n);
    if (frac.length < 2) frac = "0" + frac;
    return (neg ? "-" : "") + String(mag / 100n) + "." + frac;
  }

  function fmt2(d) {
    return fmtCents(toCents(d));
  }

  // ---- CSV, read the way Python's csv module reads it ----
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var atStart = true;
    var touched = false;
    var i = 0;
    var n = text.length;
    while (i < n) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += c;
        i++;
        continue;
      }
      if (c === '"' && atStart) {
        inQuotes = true;
        atStart = false;
        touched = true;
        i++;
        continue;
      }
      if (c === ",") {
        row.push(field);
        field = "";
        atStart = true;
        touched = true;
        i++;
        continue;
      }
      if (c === "\r" || c === "\n") {
        if (touched) {
          row.push(field);
          rows.push(row);
        }
        row = [];
        field = "";
        atStart = true;
        touched = false;
        if (c === "\r" && text[i + 1] === "\n") i++;
        i++;
        continue;
      }
      field += c;
      atStart = false;
      touched = true;
      i++;
    }
    if (touched || inQuotes) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  var DATE_COLS = ["period_begin", "period_end", "work_date"];
  var SAME_FOR_EMPLOYEE = ["middle_initial", "gender", "ethnicity"];
  var SAME_FOR_LABOR = ["apprentice", "st_rate", "ot_rate", "gross_pay", "total_deductions", "net_pay", "fica", "federal_tax", "state_tax", "medicare", "other_deductions"].concat(LINE_OPTIONAL);
  var NUMBER_COLS = ["st_rate", "ot_rate", "gross_pay", "total_deductions", "net_pay", "fica", "federal_tax", "state_tax", "medicare", "project_gross", "lump_sum", "apprentice_pct", "fringe_benefits"]
    .concat(FRINGE_RATE_COLS.map(function (f) { return f[0]; }));
  var US_DATE = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/;

  // Excel saves 2026-10-04 back out as 10/4/2026. Read both.
  function isoDate(value) {
    var m = US_DATE.exec(value.trim());
    if (!m) return value;
    var pad = function (x) { return x.length < 2 ? "0" + x : x; };
    return m[3] + "-" + pad(String(+m[1])) + "-" + pad(String(+m[2]));
  }

  var ENCODING_HELP = "Cannot tell this file's text encoding, so accented names could come out wrong. In Excel, save it again with File, Save As, CSV UTF-8.";
  var CP1252_HOLES = /[\u0081\u008d\u008f\u0090\u009d]/;

  // UTF-8 (with or without a BOM). Failing that, Excel's plain CSV save, which is Windows-1252. A file mixing the two is refused.
  function decodeCsvBytes(bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (e) {
      // not UTF-8
    }
    var loose = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    for (var ch of loose) {
      if (ch.charCodeAt(0) > 127 && ch !== "\ufffd") throw new ConvertError(ENCODING_HELP);
    }
    var text = new TextDecoder("windows-1252").decode(bytes);
    if (CP1252_HOLES.test(text)) throw new ConvertError(ENCODING_HELP);
    return text;
  }

  // Read the bytes the way an XML parser would: BOM first, then the encoding the declaration names.
  // Throws Error with a plain message when the bytes and the declared encoding disagree.
  function decodeXmlBytes(bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var b = bytes;
    var label = null;
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) label = "utf-8";
    else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) label = "utf-16le";
    else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) label = "utf-16be";
    else if (b.length >= 4 && b[0] === 0x3c && b[1] === 0x00 && b[2] === 0x3f && b[3] === 0x00) label = "utf-16le";
    else if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x3c && b[2] === 0x00 && b[3] === 0x3f) label = "utf-16be";
    if (!label) {
      var head = new TextDecoder("windows-1252").decode(b.subarray(0, 300));
      var m = /^\s*<\?xml[^>]*?encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head);
      label = m ? m[1] : "utf-8";
      if (/^utf-?16/i.test(label)) throw new Error("the file says it is " + label + " but its bytes are not UTF-16. Save it again as UTF-8.");
    }
    var dec;
    try {
      dec = new TextDecoder(label, { fatal: true });
    } catch (e) {
      throw new Error("unknown text encoding " + pyRepr(label));
    }
    try {
      return dec.decode(b);
    } catch (e) {
      throw new Error("the file says it is " + label + " but holds bytes that are not " + label + ". Save it again as UTF-8.");
    }
  }

  function readRows(text) {
    var table = parseCsv(text);
    if (!table.length) throw new ConvertError("CSV is missing columns: " + REQUIRED.join(", "));
    var header = table[0].map(function (h) { return h.trim(); });
    var missing = REQUIRED.filter(function (c) { return header.indexOf(c) < 0; });
    if (missing.length) throw new ConvertError("CSV is missing columns: " + missing.join(", "));
    var rows = [];
    for (var k = 1; k < table.length; k++) {
      var cells = table[k];
      var obj = {};
      for (var j = 0; j < header.length; j++) {
        obj[header[j]] = cells[j] !== undefined ? cells[j] : "";
      }
      var blank = true;
      for (var key in obj) {
        if (obj[key].trim() !== "") {
          blank = false;
          break;
        }
      }
      if (blank) continue; // spreadsheet exports often end with rows of bare commas
      OPTIONAL.forEach(function (col) {
        if (!Object.prototype.hasOwnProperty.call(obj, col)) obj[col] = "";
      });
      var cols = REQUIRED.concat(OPTIONAL);
      for (var c = 0; c < cols.length; c++) {
        if (BAD_XML_CHARS.test(obj[cols[c]])) {
          throw new ConvertError("row " + (k + 1) + ": " + cols[c] + " holds a control character XML cannot carry: " + pyRepr(obj[cols[c]]));
        }
      }
      DATE_COLS.forEach(function (col) { obj[col] = isoDate(obj[col]); });
      obj._row = k + 1;
      rows.push(obj);
    }
    if (!rows.length) throw new ConvertError("CSV has no data rows");
    return rows;
  }

  // The field definitions allow 3 decimals on the straight time rate and 4 on the overtime rate. Rates keep what was typed, up to that.
  var RATE_PLACES = { st_rate: 3, ot_rate: 4 };

  // Returns {m, s}: the rate rounded to at least 2 and at most 3 or 4 places.
  function rate(value, field, rowNo) {
    var v = (value || "").trim().replace(/\$/g, "").replace(/,/g, "");
    if (v === "") return { m: 0n, s: 2 };
    var d = parseDecimal(v);
    if (d === null) throw new ConvertError("row " + rowNo + ": " + field + " is not a number: " + pyRepr(value));
    var k = Math.min(Math.max(d.s, 2), RATE_PLACES[field]);
    return { m: toScale(d, k), s: k };
  }

  function dec(value, field, rowNo) {
    var v = (value || "").trim().replace(/\$/g, "").replace(/,/g, "");
    if (v === "") return 0n;
    var d = parseDecimal(v);
    if (d === null) throw new ConvertError("row " + rowNo + ": " + field + " is not a number: " + pyRepr(value));
    return toCents(d);
  }

  // A fringe rate in dollars and cents (field definitions: ###.##), null when blank or 0. More decimals stop the run instead of rounding the rate.
  function fringeRate(value, field, rowNo) {
    var v = (value || "").trim().replace(/\$/g, "").replace(/,/g, "");
    if (v === "") return null;
    var d = parseDecimal(v);
    if (d === null) throw new ConvertError("row " + rowNo + ": " + field + " is not a number: " + pyRepr(value));
    var c = toCents(d);
    if (!decEq(d, { m: c, s: 2 })) {
      throw new ConvertError("row " + rowNo + ": " + field + " has more than 2 decimals: " + pyRepr(value) + ". The field definitions take a fringe rate in dollars and cents.");
    }
    return c === 0n ? null : c;
  }

  // name | account ID | trustee | phone, and an optional | class. null when blank.
  function program(value, field, rowNo) {
    if (!value.trim()) return null;
    var parts = value.split("|").map(function (p) { return p.trim(); });
    if ((parts.length !== 4 && parts.length !== 5) || !parts.slice(0, 4).every(function (p) { return p !== ""; })) {
      throw new ConvertError("row " + rowNo + ": " + field + " needs name | account ID | trustee | phone, plus | class for other 1 and 2, got " + pyRepr(value.trim()));
    }
    return parts;
  }

  function boolText(value) {
    var v = (value || "").trim().toLowerCase();
    return ["1", "y", "yes", "true", "t"].indexOf(v) >= 0 ? "true" : "false";
  }

  // The system takes the words Male or Female. M and F are mapped; anything else passes through for the checker to flag.
  function genderText(value) {
    var v = (value || "").trim();
    var map = { m: "Male", male: "Male", f: "Female", female: "Female" };
    return Object.prototype.hasOwnProperty.call(map, v.toLowerCase()) ? map[v.toLowerCase()] : v;
  }

  // The field definitions allow Cash, Plan Funds, or Plan Funds with Exceptions. Case is fixed; anything else passes through for the checker to flag.
  function fringeText(value) {
    var v = (value || "").trim();
    var map = { "cash": "Cash", "plan funds": "Plan Funds", "plan funds with exceptions": "Plan Funds with Exceptions" };
    return Object.prototype.hasOwnProperty.call(map, v.toLowerCase()) ? map[v.toLowerCase()] : v;
  }

  // ---- a tiny element tree, written the way lxml pretty_print writes it ----
  function El(tag, text) {
    this.tag = tag;
    this.text = text === undefined ? null : text;
    this.kids = [];
  }
  El.prototype.add = function (tag, text) {
    var e = new El(tag, text === undefined ? null : String(text));
    this.kids.push(e);
    return e;
  };

  var BAD_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;

  function esc(s) {
    if (BAD_XML_CHARS.test(s)) {
      throw new ConvertError("a cell holds a control character XML cannot carry: " + pyRepr(s));
    }
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
  }

  function write(e, depth, out, rootAttrs) {
    var pad = "  ".repeat(depth);
    var open = "<" + e.tag + (rootAttrs || "");
    if (e.kids.length) {
      out.push(pad + open + ">\n");
      for (var i = 0; i < e.kids.length; i++) write(e.kids[i], depth + 1, out);
      out.push(pad + "</" + e.tag + ">\n");
    } else if (e.text === null) {
      out.push(pad + open + "/>\n");
    } else {
      out.push(pad + open + ">" + esc(e.text) + "</" + e.tag + ">\n");
    }
  }

  // amount is cents (BigInt) or {m, s} for a rate with more places.
  function currency(parent, tag, amount) {
    var wrap = parent.add(tag);
    var cur = wrap.add("txl:Currency");
    cur.add("txl:amount", typeof amount === "bigint" ? fmtCents(amount) : fmtScaled(amount.m, amount.s));
    return wrap;
  }

  function buildXml(rows) {
    var first = rows[0];
    HEADER_COLS.concat(PROGRAM_COLS.map(function (p) { return p[0]; })).forEach(function (c) {
      var seen = {};
      var vals = [];
      rows.forEach(function (r) {
        var v = (r[c] || "").trim();
        if (!Object.prototype.hasOwnProperty.call(seen, v)) {
          seen[v] = true;
          vals.push(v);
        }
      });
      if (vals.length !== 1) {
        vals.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
        throw new ConvertError("column " + c + " must be the same on every row, found " + pyListRepr(vals));
      }
    });

    var pn = first.payroll_number.trim();
    if (!/^[+-]?[0-9]+$/.test(pn)) {
      throw new ConvertError("payroll_number must be a whole number, got " + pyRepr(pn));
    }

    var root = new El("Payroll");
    root.add("vendorID", first.vendor_id.trim());
    root.add("contractID", first.contract_id.trim());
    root.add("payrollNumber", String(BigInt(pn)));
    root.add("payrollBeginDate", first.period_begin.trim());
    root.add("payrollEndDate", first.period_end.trim());
    root.add("fringeBenefitPaymentType", fringeText(first.fringe_type));
    var programs = [];
    PROGRAM_COLS.forEach(function (pc) {
      var parts = program(first[pc[0]], pc[0], first._row !== undefined ? first._row : 2);
      if (parts) programs.push([pc[1], parts]);
    });
    if (programs.length) {
      var progsEl = root.add("PayrollBenefitPrograms");
      programs.forEach(function (pr) {
        var prog = progsEl.add("PayrollBenefitProgram");
        ["benefitProgramName", "benefitAccountID", "trusteeContactPerson", "trusteeContactPhoneNumber"].forEach(function (tag, i) {
          prog.add(tag, pr[1][i]);
        });
        prog.add("benefitProgramType", pr[0]);
        if (pr[1].length === 5 && pr[1][4]) prog.add("benefitProgramClass", pr[1][4]);
      });
    }

    // group: employee -> labor class -> day rows, in first-seen order
    var employees = new Map();
    rows.forEach(function (r, idx) {
      var n = r._row !== undefined ? r._row : idx + 2;
      var ekey = JSON.stringify([r.last_name.trim(), r.first_name.trim(), r.ssn.trim(), r.employee_id.trim()]);
      var lkey = JSON.stringify([r.craft_code.trim(), r.labor_class.trim(), r.project_id.trim()]);
      if (!employees.has(ekey)) employees.set(ekey, new Map());
      var labors = employees.get(ekey);
      if (!labors.has(lkey)) labors.set(lkey, []);
      labors.get(lkey).push([n, r]);
    });

    // The XML holds these once per employee or labor line, taken from the first row. A different value on a later row would be lost, so stop.
    function same(col, r, n) {
      if (Object.prototype.hasOwnProperty.call(RATE_PLACES, col)) return String(toScale(rate(r[col], col, n), 4));
      if (NUMBER_COLS.indexOf(col) >= 0) return String(dec(r[col], col, n));
      if (col === "gender") return genderText(r[col]);
      if (col === "apprentice") return boolText(r[col]);
      return r[col].trim();
    }
    employees.forEach(function (labors) {
      var first = labors.values().next().value[0];
      labors.forEach(function (dayrows) {
        var lfirst = dayrows[0];
        dayrows.forEach(function (pair) {
          var n = pair[0];
          var r = pair[1];
          [[SAME_FOR_EMPLOYEE, first, "employee"], [SAME_FOR_LABOR, lfirst, "employee and labor class"]].forEach(function (spec) {
            spec[0].forEach(function (c) {
              if (same(c, r, n) !== same(c, spec[1][1], spec[1][0])) {
                throw new ConvertError("row " + n + ": " + c + " is " + pyRepr(r[c].trim()) + " here but " + pyRepr(spec[1][1][c].trim()) +
                  " on row " + spec[1][0] + ". It must be the same on every row for one " + spec[2] + ".");
              }
            });
          });
        });
      });
    });

    var empsEl = root.add("PayrollEmployees");
    employees.forEach(function (labors) {
      var row0 = labors.values().next().value[0][1];
      var emp = empsEl.add("PayrollEmployee");
      emp.add("lastName", row0.last_name.trim());
      emp.add("firstName", row0.first_name.trim());
      emp.add("middleInitial", row0.middle_initial.trim());
      var ssn = row0.ssn.trim().replace(/-/g, "").replace(/ /g, "");
      if (ssn) {
        if (cpLen(ssn) === 4) emp.add("PartialSsn", ssn);
        else emp.add("socialSecurityNumber", ssn);
      }
      if (row0.employee_id.trim()) emp.add("vendorSuppliedEmployeeID", row0.employee_id.trim());
      emp.add("gender", genderText(row0.gender));
      emp.add("ethnicity", row0.ethnicity.trim());
      // Required by the importing system even though the schema marks it optional.
      emp.add("changeIndicator", "true");

      var laborsEl = emp.add("PayrollEmployeeLabors");
      labors.forEach(function (dayrows) {
        var n0 = dayrows[0][0];
        var l0 = dayrows[0][1];
        var lab = laborsEl.add("PayrollEmployeeLabor");
        lab.add("craftCode", l0.craft_code.trim());
        lab.add("laborClass", l0.labor_class.trim());
        lab.add("projectID", l0.project_id.trim());
        lab.add("ojtProgramIndicator", "false");
        var stRate = rate(l0.st_rate, "st_rate", n0);
        var otRate = rate(l0.ot_rate, "ot_rate", n0);
        currency(lab, "straightTimeHourlyRate", stRate);
        currency(lab, "overtimeHourlyRate", otRate);
        FRINGE_RATE_COLS.forEach(function (fc) {
          var fr = fringeRate(l0[fc[0]], fc[0], n0);
          if (fr !== null) currency(lab, fc[1], fr);
        });
        var lump = dec(l0.lump_sum, "lump_sum", n0);
        if (l0.lump_sum.trim()) currency(lab, "lumpSumPayment", lump);
        lab.add("apprentice", boolText(l0.apprentice));
        if (boolText(l0.apprentice) === "true") {
          if (l0.apprentice_id.trim()) lab.add("apprenticeID", l0.apprentice_id.trim());
          if (l0.apprentice_pct.trim()) lab.add("apprenticeWagePercentage", fmtCents(dec(l0.apprentice_pct, "apprentice_pct", n0)));
        }

        var stTotal = 0n;
        var otTotal = 0n;
        var days = [];
        dayrows.forEach(function (pair) {
          var n = pair[0];
          var r = pair[1];
          var st = dec(r.st_hours, "st_hours", n);
          var ot = dec(r.ot_hours, "ot_hours", n);
          stTotal += st;
          otTotal += ot;
          days.push([r.work_date.trim(), st, ot]);
        });

        lab.add("totalHours", fmtCents(stTotal + otTotal));
        lab.add("straightTimeHours", fmtCents(stTotal));
        lab.add("overtimeHours", fmtCents(otTotal));
        currency(lab, "grossPay", dec(l0.gross_pay, "gross_pay", n0));
        currency(lab, "totalDeductions", dec(l0.total_deductions, "total_deductions", n0));
        currency(lab, "netPay", dec(l0.net_pay, "net_pay", n0));
        if (l0.fringe_benefits.trim()) currency(lab, "fringeBenefits", dec(l0.fringe_benefits, "fringe_benefits", n0));
        // Required by the field definitions though the schema marks it optional. The state spreadsheets fill it in too.
        var project = l0.project_gross.trim()
          ? dec(l0.project_gross, "project_gross", n0)
          : toCents(decAdd(decAdd(decMul(stRate, { m: stTotal, s: 2 }), decMul(otRate, { m: otTotal, s: 2 })), { m: lump, s: 2 }));
        currency(lab, "grossProjectAmountEarned", project);
        currency(lab, "fICAAmount", dec(l0.fica, "fica", n0));
        currency(lab, "federalWithholdingTaxAmount", dec(l0.federal_tax, "federal_tax", n0));
        currency(lab, "stateWithholdingTaxAmount", dec(l0.state_tax, "state_tax", n0));
        currency(lab, "medicareAmount", dec(l0.medicare, "medicare", n0));

        var hoursEl = lab.add("PayrollEmployeeLaborHours");
        days.forEach(function (d) {
          var h = hoursEl.add("PayrollEmployeeLaborHour");
          h.add("laborHourDate", d[0]);
          var hh = h.add("hourlyHours");
          hh.add("straightTimeHours", fmtCents(d[1]));
          hh.add("overtimeHours", fmtCents(d[2]));
        });

        var other = (l0.other_deductions || "").trim();
        var pairs = [];
        if (other) {
          other.split(";").forEach(function (p) {
            p = p.trim();
            if (!p) return;
            var at = p.lastIndexOf(":");
            if (at < 0) throw new ConvertError("row " + n0 + ": other_deductions entry " + pyRepr(p) + " needs description:amount");
            pairs.push([p.slice(0, at).trim(), dec(p.slice(at + 1), "other_deductions", n0)]);
          });
        }
        if (pairs.length) {
          var odEl = lab.add("PayrollEmployeeOtherDeductions");
          pairs.forEach(function (p) {
            var od = odEl.add("PayrollEmployeeOtherDeduction");
            od.add("description", p[0]);
            currency(od, "amount", p[1]);
          });
        }
      });
    });

    var out = ["<?xml version='1.0' encoding='UTF-8'?>\n"];
    write(root, 0, out, ' xmlns="' + PRL_NS + '" xmlns:txl="' + TXL_NS + '"');
    return out.join("");
  }

  // Returns the XML text. Throws ConvertError with a plain message.
  function convertCsv(text) {
    return buildXml(readRows(text));
  }

  // ---- check: the rules from check.py, same order, same words ----
  var MAX_LEN = [
    ["vendorID", 20], ["contractID", 20], ["lastName", 40], ["firstName", 40],
    ["vendorSuppliedEmployeeID", 40], ["ethnicity", 20], ["craftCode", 20], ["laborClass", 20], ["projectID", 18],
    ["PartialSsn", 20], ["benefitProgramName", 80], ["benefitAccountID", 40], ["trusteeContactPerson", 40],
    ["trusteeContactPhoneNumber", 13], ["benefitProgramClass", 20], ["apprenticeID", 20], ["description", 256], ["explanation", 256]
  ];
  var FRINGE_TYPES = ["Cash", "Plan Funds", "Plan Funds with Exceptions"];
  var PLAN_FUNDS = ["Plan Funds", "Plan Funds with Exceptions"];
  var PROGRAM_TYPES = ["Fringe Health/Welfare", "Fringe Vacation/Holiday", "Fringe Apprenticeship Fund", "Fringe Pension", "Fringe Other 1", "Fringe Other 2"];
  var FRINGE_RATES = ["healthWellfareRate", "vacationHolidayRate", "apprenticeshipFundRate", "pensionRate", "other1Rate", "other2Rate"];
  var DEDUCTION_PARTS = ["fICAAmount", "federalWithholdingTaxAmount", "stateWithholdingTaxAmount", "medicareAmount"];
  var ZERO = { m: 0n, s: 0 };
  var ONE_CENT = { m: 1n, s: 2 };
  var DAY = { m: 24n, s: 0 };

  function isTrue(s) {
    var v = s.toLowerCase();
    return v === "true" || v === "1";
  }

  function decCmp(a, b) {
    var x = align(a, b);
    return x[0] < x[1] ? -1 : x[0] > x[1] ? 1 : 0;
  }

  function decMul(a, b) {
    return { m: a.m * b.m, s: a.s + b.s };
  }

  function elementKids(node) {
    var out = [];
    for (var c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c);
    return out;
  }

  function isP(node, tag) {
    return node.namespaceURI === PRL_NS && node.localName === tag;
  }

  function kidsNamed(node, tag) {
    return elementKids(node).filter(function (c) { return isP(c, tag); });
  }

  function kidNamed(node, tag) {
    var k = kidsNamed(node, tag);
    return k.length ? k[0] : null;
  }

  function descNamed(node, tag) {
    var out = [];
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        if (isP(c, tag)) out.push(c);
        walk(c);
      }
    })(node);
    return out;
  }

  // lxml's .text: the text before the first child node that is not text. null when there is none.
  function leadText(node) {
    var s = null;
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 || c.nodeType === 4) s = (s || "") + c.data;
      else break;
    }
    return s;
  }

  function t(node, tag) {
    var e = kidNamed(node, tag);
    return e ? (leadText(e) || "").trim() : "";
  }

  function lenErrors(node, who, extra) {
    var out = [];
    MAX_LEN.concat(extra || []).forEach(function (pair) {
      kidsNamed(node, pair[0]).forEach(function (e) {
        var v = leadText(e) || "";
        var n = cpLen(v);
        if (n > pair[1]) out.push(who + pair[0] + " is " + n + " characters, the limit is " + pair[1]);
      });
    });
    return out;
  }

  // xs:date: YYYY-MM-DD, with an optional time zone that the tool ignores. Returns a day number or null.
  function parseDate(s) {
    var m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:Z|[+-][0-9]{2}:[0-9]{2})?$/.exec(s);
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
    var dt = new Date(0);
    dt.setUTCFullYear(y, mo - 1, d);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(dt.getTime() / 86400000);
  }

  function firstGrandchild(node, tag) {
    var c = kidNamed(node, tag);
    if (!c) return null;
    var mids = elementKids(c);
    for (var i = 0; i < mids.length; i++) {
      var g = elementKids(mids[i]);
      if (g.length) return g[0];
    }
    return null;
  }

  // The amount inside a currency field. null when the field is absent, "" when it holds no amount.
  function cur(node, tag) {
    if (!kidNamed(node, tag)) return null;
    var g = firstGrandchild(node, tag);
    return g ? (leadText(g) || "").trim() : "";
  }

  // xmldom also accepts a file whose last closing tag was cut off. Browsers and lxml do not.
  function rootClosed(text, rootEl) {
    var tail = text.replace(/\s+$/, "");
    for (;;) {
      if (/-->$/.test(tail) && tail.lastIndexOf("<!--") >= 0) tail = tail.slice(0, tail.lastIndexOf("<!--")).replace(/\s+$/, "");
      else if (/\?>$/.test(tail) && tail.lastIndexOf("<?") > 0) tail = tail.slice(0, tail.lastIndexOf("<?")).replace(/\s+$/, "");
      else break;
    }
    var tag = rootEl.tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("</" + tag + "\\s*>$").test(tail)) return true;
    return !rootEl.firstChild && /\/>$/.test(tail);
  }

  function parseXml(text, DOMParserImpl) {
    var fatal = null;
    var doc;
    if (DOMParserImpl) {
      // xmldom (used under Node) only warns about an element left open at the end of the file.
      // Browsers and lxml refuse that file, so treat it as fatal here too.
      var unclosed = function (m) { if (/unclosed/.test(String(m))) fatal = fatal || m; };
      var handler = {
        warning: unclosed,
        error: function (m) { fatal = fatal || m; },
        fatalError: function (m) { fatal = fatal || m; }
      };
      var onError = function (level, m) { if (level !== "warning") fatal = fatal || m; else unclosed(m); };
      var parser;
      try {
        parser = new DOMParserImpl({ errorHandler: handler }); // xmldom 0.8
      } catch (e) {
        parser = new DOMParserImpl({ onError: onError }); // xmldom 0.9 refuses errorHandler
      }
      doc = parser.parseFromString(text, "text/xml");
    } else {
      doc = new DOMParser().parseFromString(text, "application/xml");
    }
    if (fatal) throw new Error(String(fatal).split("\n")[0]);
    if (!doc || !doc.documentElement) throw new Error("no root element");
    if (DOMParserImpl && !rootClosed(text, doc.documentElement)) throw new Error("the root element " + doc.documentElement.tagName + " is never closed");
    var perr = doc.getElementsByTagName("parsererror");
    if (perr.length || doc.documentElement.localName === "parsererror") {
      var msg = (perr.length ? perr[0].textContent : doc.documentElement.textContent) || "parse error";
      msg = msg.replace(/This page contains the following errors:/, "").replace(/Below is a rendering of the page up to the first error\.?/, "");
      throw new Error(msg.replace(/\s+/g, " ").trim());
    }
    return doc;
  }

  // The fields that place one payroll among others. null when the text is not readable Payroll XML.
  var HEADER = [["vendor", "vendorID"], ["contract", "contractID"], ["number", "payrollNumber"],
    ["begin", "payrollBeginDate"], ["end", "payrollEndDate"]];
  function headerOf(text, DOMParserImpl) {
    var doc;
    try {
      doc = parseXml(text, DOMParserImpl);
    } catch (e) {
      return null;
    }
    var root = doc.documentElement;
    if (root.localName !== "Payroll" || root.namespaceURI !== PRL_NS) return null;
    var h = {};
    HEADER.forEach(function (f) { h[f[0]] = t(root, f[1]); });
    return h;
  }

  // Warnings about files that clash with each other. items: [{name, header}] in order; header may be null.
  // prlxml/check.py across() gives the same lines.
  function acrossFiles(items) {
    var out = [];
    var ok = items.filter(function (it) { return it.header && it.header.contract; });
    for (var i = 0; i < ok.length; i++) {
      var a = ok[i].name, ha = ok[i].header;
      for (var j = i + 1; j < ok.length; j++) {
        var b = ok[j].name, hb = ok[j].header;
        if (ha.vendor !== hb.vendor || ha.contract !== hb.contract) continue;
        var who = "contract " + ha.contract + (ha.vendor ? ", vendor " + ha.vendor : "");
        if (ha.number && ha.number === hb.number) {
          out.push(a + " and " + b + " are both payroll number " + ha.number + " for " + who + ". If one is not a correction of the other, renumber it");
          continue;
        }
        var a0 = parseDate(ha.begin), a1 = parseDate(ha.end), b0 = parseDate(hb.begin), b1 = parseDate(hb.end);
        if (a0 === null || a1 === null || b0 === null || b1 === null) continue;
        if (a0 <= b1 && b0 <= a1) {
          out.push(a + " (payroll " + ha.number + ", " + ha.begin.slice(0, 10) + " to " + ha.end.slice(0, 10) + ") and " + b +
            " (payroll " + hb.number + ", " + hb.begin.slice(0, 10) + " to " + hb.end.slice(0, 10) + ") cover the same days for " + who);
        }
      }
    }
    return out;
  }

  // Returns {errors, warnings}, two lists of plain-English lines.
  // An error is something the field definitions require or an import rejects.
  // A warning is something a state reviewer would question; the file may still import.
  function scanXml(text, DOMParserImpl) {
    var doc;
    try {
      doc = parseXml(text, DOMParserImpl);
    } catch (e) {
      return { errors: ["not well-formed XML: " + e.message], warnings: [] };
    }
    var root = doc.documentElement;
    var errs = [];
    var warns = [];
    if (root.localName !== "Payroll") return { errors: ["root element is not Payroll"], warnings: [] };
    if (root.namespaceURI !== PRL_NS) {
      return { errors: ["Payroll XML 1.2 needs the namespace " + PRL_NS + ", this file has " + (root.namespaceURI || "(none)")], warnings: [] };
    }
    errs = errs.concat(lenErrors(root, "", [["comments", 256]]));

    var b = t(root, "payrollBeginDate");
    var e = t(root, "payrollEndDate");
    var begin = parseDate(b);
    var end = parseDate(e);
    if (begin === null || end === null) {
      errs.push("bad period date: begin " + pyRepr(b) + ", end " + pyRepr(e));
      begin = end = null;
    } else if (end - begin !== 6) {
      errs.push("pay period must be seven days: " + b.slice(0, 10) + " to " + e.slice(0, 10) + " is " + (end - begin + 1) + " days");
    }

    var pn = t(root, "payrollNumber");
    if (!/^[0-9]+$/.test(pn) || BigInt(pn) < 1n) {
      errs.push("payrollNumber must be a whole number starting at 1, got " + pyRepr(pn));
    }
    var cid = t(root, "contractID");
    if (cid.indexOf(" ") >= 0 || cid.indexOf("-") >= 0) errs.push("contractID must have no dashes or spaces");

    var ft = t(root, "fringeBenefitPaymentType");
    if (FRINGE_TYPES.indexOf(ft) < 0) {
      errs.push("fringeBenefitPaymentType must be Cash, Plan Funds, or Plan Funds with Exceptions, got " + pyRepr(ft));
    }

    var names = {};
    descNamed(root, "PayrollBenefitProgram").forEach(function (prog, idx) {
      var who = "benefit program " + (idx + 1) + ": ";
      errs = errs.concat(lenErrors(prog, who));
      ["benefitProgramName", "benefitAccountID", "trusteeContactPerson", "trusteeContactPhoneNumber"].forEach(function (tag) {
        if (!t(prog, tag)) errs.push(who + tag + " is required");
      });
      var ptype = t(prog, "benefitProgramType");
      if (PROGRAM_TYPES.indexOf(ptype) < 0) {
        errs.push(who + "benefitProgramType must be one of " + PROGRAM_TYPES.join(", ") + ", got " + pyRepr(ptype));
      } else if ((ptype === "Fringe Other 1" || ptype === "Fringe Other 2") && !t(prog, "benefitProgramClass")) {
        errs.push(who + "benefitProgramClass is required for " + ptype);
      }
      var name = t(prog, "benefitProgramName");
      if (name && Object.prototype.hasOwnProperty.call(names, name)) {
        errs.push(who + "benefitProgramName " + pyRepr(name) + " is used twice; each program needs its own name");
      }
      names[name] = true;
    });

    if (ft === "Plan Funds with Exceptions" && !descNamed(root, "PayrollEmployeeFringeBenefitException").length) {
      warns.push("fringe type is Plan Funds with Exceptions, but no employee has a fringe benefit exception");
    }

    var seenPeople = new Map();
    descNamed(root, "PayrollEmployee").forEach(function (emp) {
      var who = t(emp, "lastName") + ", " + t(emp, "firstName");
      seenPeople.set(who, (seenPeople.get(who) || 0) + 1);
      errs = errs.concat(lenErrors(emp, who + ": ", [["comments", 3999]]));
      var g = t(emp, "gender");
      if (g && g !== "Male" && g !== "Female") errs.push(who + ": gender must be the word Male or Female, got " + pyRepr(g));
      if (!kidNamed(emp, "changeIndicator")) errs.push(who + ": changeIndicator is missing; the importing system requires true or false");
      var mi = t(emp, "middleInitial");
      if (cpLen(mi) > 1) errs.push(who + ": middleInitial must be one character, got " + pyRepr(mi));
      var ssn = t(emp, "socialSecurityNumber");
      if (ssn && !/^[0-9]{9}$/.test(ssn)) errs.push(who + ": socialSecurityNumber must be 9 digits, no dashes or spaces");
      if (!(ssn || t(emp, "PartialSsn") || t(emp, "vendorSuppliedEmployeeID"))) {
        errs.push(who + ": no employee ID; give socialSecurityNumber, PartialSsn or vendorSuppliedEmployeeID, whichever your state asks for");
      }
      var salaried = isTrue(t(emp, "salariedEmployeeIndicator"));

      var empTotal = ZERO;
      var empBad = false;
      var empDays = new Map();
      descNamed(emp, "PayrollEmployeeLabor").forEach(function (lab) {
        var cls = t(lab, "laborClass");
        var pre = who + " " + cls + ": ";
        errs = errs.concat(lenErrors(lab, pre));

        var rates = {};
        var rateCount = 0;
        var otZero = null; // an overtime rate of 0 is judged after the hours are counted
        if (salaried) {
          if (cur(lab, "straightTimeHourlyRate") !== null || cur(lab, "overtimeHourlyRate") !== null) {
            errs.push(pre + "a salaried employee has no straightTimeHourlyRate or overtimeHourlyRate; take them out");
          }
        } else {
          ["straightTimeHourlyRate", "overtimeHourlyRate"].forEach(function (tag) {
            var v = cur(lab, tag);
            var n = v ? parseDecimal(v) : null;
            if (!v) errs.push(pre + tag + " is required for an hourly employee");
            else if (n === null) errs.push(pre + tag + " " + pyRepr(v) + " is not a number");
            else if (n.m < 0n || (n.m === 0n && tag === "straightTimeHourlyRate")) errs.push(pre + tag + " must be more than 0, got " + v);
            else {
              rates[tag] = n;
              rateCount++;
              if (n.m === 0n) otZero = v;
            }
          });
        }

        var hasFringeRate = false;
        FRINGE_RATES.forEach(function (tag) {
          var v = cur(lab, tag);
          if (v === null) return;
          var n = parseDecimal(v);
          if (n === null) errs.push(pre + tag + " " + pyRepr(v) + " is not a number");
          else if (n.m <= 0n) errs.push(pre + tag + " must be more than 0 when it is in the file, got " + v);
          else hasFringeRate = true;
        });

        if (isTrue(t(lab, "ojtProgramIndicator")) && !t(lab, "ojtWagePercentage")) {
          errs.push(pre + "ojtWagePercentage is required when ojtProgramIndicator is true");
        }
        if (isTrue(t(lab, "apprentice"))) {
          ["apprenticeID", "apprenticeWagePercentage"].forEach(function (tag) {
            if (!t(lab, tag)) errs.push(pre + tag + " is required when apprentice is true");
          });
        }

        var stSum = ZERO;
        var otSum = ZERO;
        var salSum = ZERO;
        var daysOk = true;
        var seenDays = {};
        descNamed(lab, "PayrollEmployeeLaborHour").forEach(function (h) {
          var ds = t(h, "laborHourDate");
          var d = parseDate(ds);
          if (d === null) {
            errs.push(pre + "bad laborHourDate " + pyRepr(ds));
            daysOk = false;
            return;
          }
          ds = ds.slice(0, 10);
          if (begin !== null && !(begin <= d && d <= end)) errs.push(pre + "hours on " + ds + " fall outside the pay period");
          if (Object.prototype.hasOwnProperty.call(seenDays, ds)) warns.push(pre + ds + " is listed twice; merge it into one day");
          seenDays[ds] = true;
          var hh = kidNamed(h, "hourlyHours");
          var sh = kidNamed(h, "salariedEmployeeHours");
          var day;
          var at = who + " " + cls + " " + ds + ": ";
          if (hh) {
            if (salaried) errs.push(at + "a salaried employee reports salariedEmployeeHours, not straight and overtime hours");
            var st = t(hh, "straightTimeHours");
            var ot = t(hh, "overtimeHours");
            var otTag = !!kidNamed(hh, "overtimeHours");
            if (st === "" || (otTag && ot === "")) errs.push(at + "straight and overtime hours must both be filled, use 0.00");
            else if (!otTag) warns.push(at + "overtimeHours is left out; Wisconsin's import wants 0.00 on a day with no overtime");
            var stN = parseDecimal(st || "0");
            var otN = parseDecimal(ot || "0");
            if (stN === null || otN === null) {
              errs.push(at + "hours must be numbers, got " + pyRepr(st) + " and " + pyRepr(ot));
              daysOk = false;
              return;
            }
            if (stN.m < 0n || otN.m < 0n) errs.push(at + "hours cannot be below 0");
            stSum = decAdd(stSum, stN);
            otSum = decAdd(otSum, otN);
            day = decAdd(stN, otN);
          } else if (sh) {
            if (!salaried) errs.push(at + "salariedEmployeeHours is only for a salaried employee; use straightTimeHours and overtimeHours");
            var s = (leadText(sh) || "").trim();
            var sN = parseDecimal(s);
            if (sN === null) {
              errs.push(at + "salariedEmployeeHours must be a number, got " + pyRepr(s));
              daysOk = false;
              return;
            }
            if (sN.m < 0n) errs.push(at + "hours cannot be below 0");
            salSum = decAdd(salSum, sN);
            day = sN;
          } else {
            return;
          }
          empDays.set(ds, decAdd(empDays.has(ds) ? empDays.get(ds) : ZERO, day));
        });
        if (!daysOk) empBad = true;
        var labSum = decAdd(decAdd(stSum, otSum), salSum);
        empTotal = decAdd(empTotal, labSum);
        if (otZero !== null) {
          if (decCmp(otSum, ZERO) > 0) errs.push(pre + "overtimeHourlyRate must be more than 0 when there is overtime, got " + otZero);
          else warns.push(pre + "overtimeHourlyRate is " + otZero + "; some states want a rate above 0 even with no overtime");
        }

        // A salaried line reports salariedEmployeeHours by day, so its straight and overtime totals are not compared.
        (salaried ? [] : [["straightTimeHours", stSum], ["overtimeHours", otSum]]).forEach(function (pair) {
          var tot = t(lab, pair[0]);
          if (pair[0] === "straightTimeHours" && !tot) {
            errs.push(pre + "straightTimeHours is required, use 0.00 when there were none");
          } else if (tot) {
            var tv = parseDecimal(tot);
            if (tv === null) errs.push(pre + pair[0] + " total " + pyRepr(tot) + " is not a number");
            else if (!decEq(tv, pair[1])) errs.push(pre + pair[0] + " total " + tot + " does not match the daily sum " + fmt2(pair[1]));
          }
        });
        var allTot = t(lab, "totalHours");
        if (!allTot) {
          errs.push(pre + "totalHours is required");
        } else {
          var av = parseDecimal(allTot);
          if (av === null) errs.push(pre + "totalHours " + pyRepr(allTot) + " is not a number");
          else if (!decEq(av, labSum)) errs.push(pre + "totalHours " + allTot + " does not match the daily sum " + fmt2(labSum));
        }

        ["grossPay", "totalDeductions", "netPay"].forEach(function (tag) {
          if (!cur(lab, tag)) errs.push(pre + tag + " is required");
        });
        var gross = firstGrandchild(lab, "grossPay");
        var ded = firstGrandchild(lab, "totalDeductions");
        var net = firstGrandchild(lab, "netPay");
        var gv = null;
        var dv = null;
        if (gross && ded && net) {
          gv = parseDecimal(leadText(gross));
          dv = parseDecimal(leadText(ded));
          var nv = parseDecimal(leadText(net));
          if (gv === null || dv === null || nv === null) {
            errs.push(pre + "grossPay, totalDeductions and netPay must be numbers");
          } else if (!decEq(decSub(gv, dv), nv)) {
            errs.push(pre + "grossPay minus totalDeductions is not netPay (" + leadText(gross) + " - " + leadText(ded) + " != " + leadText(net) + ")");
          }
        }
        var pv = null;
        var gpe = cur(lab, "grossProjectAmountEarned");
        if (!gpe) errs.push(pre + "grossProjectAmountEarned is required, the pay for this contract and project only");
        else if (parseDecimal(gpe) === null) errs.push(pre + "grossProjectAmountEarned " + pyRepr(gpe) + " is not a number");
        else pv = parseDecimal(gpe);

        var parts = ZERO;
        var taxSeen = false;
        var partsOk = true;
        DEDUCTION_PARTS.forEach(function (tag) {
          var v = cur(lab, tag);
          if (v === null) return;
          taxSeen = true;
          var n = parseDecimal(v || "0");
          if (n === null) {
            errs.push(pre + tag + " " + pyRepr(v) + " is not a number");
            partsOk = false;
          } else parts = decAdd(parts, n);
        });
        var descs = {};
        descNamed(lab, "PayrollEmployeeOtherDeduction").forEach(function (od) {
          errs = errs.concat(lenErrors(od, pre));
          var desc = t(od, "description");
          if (Object.prototype.hasOwnProperty.call(descs, desc)) {
            errs.push(pre + "other deduction " + pyRepr(desc) + " is listed twice; each description must be unique");
          }
          descs[desc] = true;
          var v = cur(od, "amount");
          if (v === null) return;
          var n = parseDecimal(v || "0");
          if (n === null) {
            errs.push(pre + "other deduction " + pyRepr(desc) + " amount " + pyRepr(v) + " is not a number");
            partsOk = false;
          } else parts = decAdd(parts, n);
        });
        descNamed(lab, "PayrollEmployeeFringeBenefitException").forEach(function (ex) {
          errs = errs.concat(lenErrors(ex, pre));
        });

        // The four tax fields are optional. With none of them in the file the parts cannot be added up.
        if (taxSeen && partsOk && dv !== null && !decEq(parts, dv)) {
          warns.push(pre + "FICA, federal, state, Medicare and other deductions add up to " + fmt2(parts) + ", but totalDeductions is " +
            (leadText(ded) || "").trim() + "; totalDeductions should include all taxes and other deductions");
        }

        var under = false;
        if (!salaried && daysOk && rateCount === 2 && rates.straightTimeHourlyRate.m > 0n) {
          var calcC = toCents(decAdd(decMul(rates.straightTimeHourlyRate, stSum), decMul(rates.overtimeHourlyRate, otSum)));
          var calc = { m: calcC, s: 2 };
          if (pv !== null && decCmp(decSub(calc, pv), ONE_CENT) > 0) {
            warns.push(pre + "grossProjectAmountEarned " + gpe + " is less than the hours times the rates (" + fmtCents(calcC) + "); that reads as underpayment");
            under = true;
          } else if (gv !== null && decCmp(decSub(calc, gv), ONE_CENT) > 0) {
            warns.push(pre + "grossPay " + (leadText(gross) || "").trim() + " is less than the hours times the rates (" + fmtCents(calcC) + "); that reads as underpayment");
            under = true;
          }
        }
        if (!under && gv !== null && pv !== null && decCmp(gv, pv) < 0) {
          warns.push(pre + "grossPay " + (leadText(gross) || "").trim() + " is less than grossProjectAmountEarned " + gpe + "; gross pay should be the project pay plus any other pay");
        }
        if (rateCount === 2 && decCmp(otSum, ZERO) > 0 && rates.overtimeHourlyRate.m > 0n && decCmp(rates.overtimeHourlyRate, rates.straightTimeHourlyRate) < 0) {
          warns.push(pre + "overtime rate " + cur(lab, "overtimeHourlyRate") + " is lower than the straight rate " + cur(lab, "straightTimeHourlyRate"));
        }
        if (PLAN_FUNDS.indexOf(ft) >= 0 && !hasFringeRate) {
          if (ft === "Plan Funds" || !descNamed(lab, "PayrollEmployeeFringeBenefitException").length) {
            warns.push(pre + "fringe type is " + ft + " but this line has no fringe rate; fill at least one fringe rate and fringeBenefits");
          }
        }
      });

      if (!empBad && decCmp(empTotal, ZERO) === 0) {
        warns.push(who + ": no hours on this payroll; a state that sets Include Employees with Zero Hours to False rejects the file");
      }
      empDays.forEach(function (hours, ds) {
        if (decCmp(hours, DAY) > 0) warns.push(who + ": " + ds + " adds up to " + fmt2(hours) + " hours, more than a day holds");
      });
    });

    seenPeople.forEach(function (n, who) {
      if (n > 1) warns.push(who + ": listed as " + n + " separate employees; if this is one person, put all of their labor lines under one employee");
    });
    return { errors: errs, warnings: warns };
  }

  // Rule errors only, the same list check.py's rule_errors gives.
  function checkXml(text, DOMParserImpl) {
    return scanXml(text, DOMParserImpl).errors;
  }

  var SAMPLE_CSV = [
    "vendor_id,contract_id,payroll_number,period_begin,period_end,fringe_type,last_name,first_name,middle_initial,ssn,employee_id,gender,ethnicity,craft_code,labor_class,project_id,apprentice,st_rate,ot_rate,work_date,st_hours,ot_hours,gross_pay,total_deductions,net_pay,fica,federal_tax,state_tax,medicare,other_deductions",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Garcia,Luis,A,1234,E01,Male,HISP,100,101,9999-01-01,N,28.50,42.75,2026-10-05,8.00,0.00,1239.75,281.21,958.54,76.86,148.00,0.00,17.98,Union dues:38.37",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Garcia,Luis,A,1234,E01,Male,HISP,100,101,9999-01-01,N,28.50,42.75,2026-10-06,8.00,0.00,1239.75,281.21,958.54,76.86,148.00,0.00,17.98,Union dues:38.37",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Garcia,Luis,A,1234,E01,Male,HISP,100,101,9999-01-01,N,28.50,42.75,2026-10-07,8.00,1.00,1239.75,281.21,958.54,76.86,148.00,0.00,17.98,Union dues:38.37",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Garcia,Luis,A,1234,E01,Male,HISP,100,101,9999-01-01,N,28.50,42.75,2026-10-08,8.00,0.00,1239.75,281.21,958.54,76.86,148.00,0.00,17.98,Union dues:38.37",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Garcia,Luis,A,1234,E01,Male,HISP,100,101,9999-01-01,N,28.50,42.75,2026-10-09,8.00,0.00,1239.75,281.21,958.54,76.86,148.00,0.00,17.98,Union dues:38.37",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Nguyen,Tran,,5678,E02,Female,A-IN,200,201,9999-01-01,N,34.10,51.15,2026-10-05,8.00,0.00,1364.00,312.44,1051.56,84.57,160.00,0.00,19.78,Union dues:48.09",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Nguyen,Tran,,5678,E02,Female,A-IN,200,201,9999-01-01,N,34.10,51.15,2026-10-06,8.00,0.00,1364.00,312.44,1051.56,84.57,160.00,0.00,19.78,Union dues:48.09",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Nguyen,Tran,,5678,E02,Female,A-IN,200,201,9999-01-01,N,34.10,51.15,2026-10-07,8.00,0.00,1364.00,312.44,1051.56,84.57,160.00,0.00,19.78,Union dues:48.09",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Nguyen,Tran,,5678,E02,Female,A-IN,200,201,9999-01-01,N,34.10,51.15,2026-10-08,8.00,0.00,1364.00,312.44,1051.56,84.57,160.00,0.00,19.78,Union dues:48.09",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Nguyen,Tran,,5678,E02,Female,A-IN,200,201,9999-01-01,N,34.10,51.15,2026-10-09,8.00,0.00,1364.00,312.44,1051.56,84.57,160.00,0.00,19.78,Union dues:48.09",
    ""
  ].join("\n");

  return {
    PRL_NS: PRL_NS,
    TXL_NS: TXL_NS,
    REQUIRED: REQUIRED,
    ConvertError: ConvertError,
    parseCsv: parseCsv,
    decodeCsvBytes: decodeCsvBytes,
    decodeXmlBytes: decodeXmlBytes,
    convertCsv: convertCsv,
    checkXml: checkXml,
    scanXml: scanXml,
    headerOf: headerOf,
    acrossFiles: acrossFiles,
    OPTIONAL: OPTIONAL,
    SAMPLE_CSV: SAMPLE_CSV,
    TEMPLATE_CSV: REQUIRED.concat(OPTIONAL).join(",") + "\n"
  };
});
