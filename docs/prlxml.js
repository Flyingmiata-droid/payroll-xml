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
  var SAME_FOR_LABOR = ["apprentice", "st_rate", "ot_rate", "gross_pay", "total_deductions", "net_pay", "fica", "federal_tax", "state_tax", "medicare", "other_deductions"];
  var NUMBER_COLS = ["st_rate", "ot_rate", "gross_pay", "total_deductions", "net_pay", "fica", "federal_tax", "state_tax", "medicare"];
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
      for (var c = 0; c < REQUIRED.length; c++) {
        if (BAD_XML_CHARS.test(obj[REQUIRED[c]])) {
          throw new ConvertError("row " + (k + 1) + ": " + REQUIRED[c] + " holds a control character XML cannot carry: " + pyRepr(obj[REQUIRED[c]]));
        }
      }
      DATE_COLS.forEach(function (col) { obj[col] = isoDate(obj[col]); });
      obj._row = k + 1;
      rows.push(obj);
    }
    if (!rows.length) throw new ConvertError("CSV has no data rows");
    return rows;
  }

  function dec(value, field, rowNo) {
    var v = (value || "").trim().replace(/\$/g, "").replace(/,/g, "");
    if (v === "") return 0n;
    var d = parseDecimal(v);
    if (d === null) throw new ConvertError("row " + rowNo + ": " + field + " is not a number: " + pyRepr(value));
    return toCents(d);
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

  function currency(parent, tag, cents) {
    var wrap = parent.add(tag);
    var cur = wrap.add("txl:Currency");
    cur.add("txl:amount", fmtCents(cents));
    return wrap;
  }

  function buildXml(rows) {
    var first = rows[0];
    HEADER_COLS.forEach(function (c) {
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
    root.add("fringeBenefitPaymentType", first.fringe_type.trim());

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
        currency(lab, "straightTimeHourlyRate", dec(l0.st_rate, "st_rate", n0));
        currency(lab, "overtimeHourlyRate", dec(l0.ot_rate, "ot_rate", n0));
        lab.add("apprentice", boolText(l0.apprentice));

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
    ["PartialSsn", 20], ["benefitProgramName", 80], ["benefitAccountID", 40], ["trusteeContactPerson", 40]
  ];

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

  function lenErrors(node, who) {
    var out = [];
    MAX_LEN.forEach(function (pair) {
      kidsNamed(node, pair[0]).forEach(function (e) {
        var v = leadText(e) || "";
        var n = cpLen(v);
        if (n > pair[1]) out.push(who + pair[0] + " is " + n + " characters, the limit is " + pair[1]);
      });
    });
    return out;
  }

  // YYYY-MM-DD only, a real calendar day. Returns a day number or null.
  function parseDate(s) {
    var m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s);
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

  function parseXml(text, DOMParserImpl) {
    var fatal = null;
    var doc;
    if (DOMParserImpl) {
      var handler = {
        warning: function () {},
        error: function (m) { fatal = fatal || m; },
        fatalError: function (m) { fatal = fatal || m; }
      };
      doc = new DOMParserImpl({ errorHandler: handler, onError: function (level, m) { if (level !== "warning") fatal = fatal || m; } })
        .parseFromString(text, "text/xml");
    } else {
      doc = new DOMParser().parseFromString(text, "application/xml");
    }
    if (fatal) throw new Error(String(fatal).split("\n")[0]);
    if (!doc || !doc.documentElement) throw new Error("no root element");
    var perr = doc.getElementsByTagName("parsererror");
    if (perr.length || doc.documentElement.localName === "parsererror") {
      var msg = (perr.length ? perr[0].textContent : doc.documentElement.textContent) || "parse error";
      msg = msg.replace(/This page contains the following errors:/, "").replace(/Below is a rendering of the page up to the first error\.?/, "");
      throw new Error(msg.replace(/\s+/g, " ").trim());
    }
    return doc;
  }

  // Returns a list of plain-English rule errors. Empty list means the rules are clean.
  function checkXml(text, DOMParserImpl) {
    var doc;
    try {
      doc = parseXml(text, DOMParserImpl);
    } catch (e) {
      return ["not well-formed XML: " + e.message];
    }
    var root = doc.documentElement;
    var errs = [];
    if (root.localName !== "Payroll") return ["root element is not Payroll"];
    if (root.namespaceURI !== PRL_NS) {
      return ["Payroll XML 1.2 needs the namespace " + PRL_NS + ", this file has " + (root.namespaceURI || "(none)")];
    }
    errs = errs.concat(lenErrors(root, ""));

    var b = t(root, "payrollBeginDate");
    var e = t(root, "payrollEndDate");
    var begin = parseDate(b);
    var end = parseDate(e);
    if (begin === null || end === null) {
      errs.push("bad period date: begin " + pyRepr(b) + ", end " + pyRepr(e));
      begin = end = null;
    } else if (end - begin !== 6) {
      errs.push("pay period must be seven days: " + b + " to " + e + " is " + (end - begin + 1) + " days");
    }

    var pn = t(root, "payrollNumber");
    if (!/^[0-9]+$/.test(pn) || BigInt(pn) < 1n) {
      errs.push("payrollNumber must be a whole number starting at 1, got " + pyRepr(pn));
    }
    var cid = t(root, "contractID");
    if (cid.indexOf(" ") >= 0 || cid.indexOf("-") >= 0) errs.push("contractID must have no dashes or spaces");

    descNamed(root, "PayrollEmployee").forEach(function (emp) {
      var who = t(emp, "lastName") + ", " + t(emp, "firstName");
      errs = errs.concat(lenErrors(emp, who + ": "));
      var g = t(emp, "gender");
      if (g && g !== "Male" && g !== "Female") errs.push(who + ": gender must be the word Male or Female, got " + pyRepr(g));
      if (!kidNamed(emp, "changeIndicator")) errs.push(who + ": changeIndicator is missing; the importing system requires true or false");
      var mi = t(emp, "middleInitial");
      if (cpLen(mi) > 1) errs.push(who + ": middleInitial must be one character, got " + pyRepr(mi));
      var ssn = t(emp, "socialSecurityNumber");
      if (ssn && (!/^[0-9]+$/.test(ssn) || ssn.length !== 9)) errs.push(who + ": socialSecurityNumber must be 9 digits, no dashes or spaces");

      descNamed(emp, "PayrollEmployeeLabor").forEach(function (lab) {
        var cls = t(lab, "laborClass");
        errs = errs.concat(lenErrors(lab, who + " " + cls + ": "));
        var stSum = { m: 0n, s: 0 };
        var otSum = { m: 0n, s: 0 };
        descNamed(lab, "PayrollEmployeeLaborHour").forEach(function (h) {
          var ds = t(h, "laborHourDate");
          var d = parseDate(ds);
          if (d === null) {
            errs.push(who + " " + cls + ": bad laborHourDate " + pyRepr(ds));
            return;
          }
          if (begin !== null && !(begin <= d && d <= end)) errs.push(who + " " + cls + ": hours on " + ds + " fall outside the pay period");
          var hh = kidNamed(h, "hourlyHours");
          if (hh) {
            var st = t(hh, "straightTimeHours");
            var ot = t(hh, "overtimeHours");
            if (st === "" || ot === "") errs.push(who + " " + cls + " " + ds + ": straight and overtime hours must both be filled, use 0.00");
            var stN = parseDecimal(st || "0");
            var otN = parseDecimal(ot || "0");
            if (stN === null || otN === null) {
              errs.push(who + " " + cls + " " + ds + ": hours must be numbers, got " + pyRepr(st) + " and " + pyRepr(ot));
              return;
            }
            stSum = decAdd(stSum, stN);
            otSum = decAdd(otSum, otN);
          }
        });
        [["straightTimeHours", stSum], ["overtimeHours", otSum]].forEach(function (pair) {
          var tot = t(lab, pair[0]);
          if (tot) {
            var tv = parseDecimal(tot);
            if (tv === null) errs.push(who + " " + cls + ": " + pair[0] + " total " + pyRepr(tot) + " is not a number");
            else if (!decEq(tv, pair[1])) errs.push(who + " " + cls + ": " + pair[0] + " total " + tot + " does not match the daily sum " + fmt2(pair[1]));
          }
        });
        var allTot = t(lab, "totalHours");
        if (allTot) {
          var av = parseDecimal(allTot);
          var daySum = decAdd(stSum, otSum);
          if (av === null) errs.push(who + " " + cls + ": totalHours " + pyRepr(allTot) + " is not a number");
          else if (!decEq(av, daySum)) errs.push(who + " " + cls + ": totalHours " + allTot + " does not match the daily sum " + fmt2(daySum));
        }
        var gross = firstGrandchild(lab, "grossPay");
        var ded = firstGrandchild(lab, "totalDeductions");
        var net = firstGrandchild(lab, "netPay");
        if (gross && ded && net) {
          var gv = parseDecimal(leadText(gross));
          var dv = parseDecimal(leadText(ded));
          var nv = parseDecimal(leadText(net));
          if (gv === null || dv === null || nv === null) {
            errs.push(who + " " + cls + ": grossPay, totalDeductions and netPay must be numbers");
          } else if (!decEq(decSub(gv, dv), nv)) {
            errs.push(who + " " + cls + ": grossPay minus totalDeductions is not netPay (" + leadText(gross) + " - " + leadText(ded) + " != " + leadText(net) + ")");
          }
        }
      });
    });
    return errs;
  }

  var SAMPLE_CSV = [
    "vendor_id,contract_id,payroll_number,period_begin,period_end,fringe_type,last_name,first_name,middle_initial,ssn,employee_id,gender,ethnicity,craft_code,labor_class,project_id,apprentice,st_rate,ot_rate,work_date,st_hours,ot_hours,gross_pay,total_deductions,net_pay,fica,federal_tax,state_tax,medicare,other_deductions",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Garcia,Luis,A,1234,E01,Male,HISP,100,101,9999-01-01,N,28.50,42.75,2026-10-05,8.00,0.00,1239.75,281.21,958.54,76.86,148.00,0.00,17.98,Union dues:38.37",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Garcia,Luis,A,1234,E01,Male,HISP,100,101,9999-01-01,N,28.50,42.75,2026-10-06,8.00,0.00,1239.75,281.21,958.54,76.86,148.00,0.00,17.98,Union dues:38.37",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Garcia,Luis,A,1234,E01,Male,HISP,100,101,9999-01-01,N,28.50,42.75,2026-10-07,8.00,1.00,1239.75,281.21,958.54,76.86,148.00,0.00,17.98,Union dues:38.37",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Garcia,Luis,A,1234,E01,Male,HISP,100,101,9999-01-01,N,28.50,42.75,2026-10-08,8.00,0.00,1239.75,281.21,958.54,76.86,148.00,0.00,17.98,Union dues:38.37",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Garcia,Luis,A,1234,E01,Male,HISP,100,101,9999-01-01,N,28.50,42.75,2026-10-09,8.00,0.00,1239.75,281.21,958.54,76.86,148.00,0.00,17.98,Union dues:38.37",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Nguyen,Tran,,5678,E02,Female,A-IN,200,201,9999-01-01,N,34.10,51.15,2026-10-05,8.00,0.00,1364.00,312.44,1051.56,84.57,160.00,0.00,19.78,",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Nguyen,Tran,,5678,E02,Female,A-IN,200,201,9999-01-01,N,34.10,51.15,2026-10-06,8.00,0.00,1364.00,312.44,1051.56,84.57,160.00,0.00,19.78,",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Nguyen,Tran,,5678,E02,Female,A-IN,200,201,9999-01-01,N,34.10,51.15,2026-10-07,8.00,0.00,1364.00,312.44,1051.56,84.57,160.00,0.00,19.78,",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Nguyen,Tran,,5678,E02,Female,A-IN,200,201,9999-01-01,N,34.10,51.15,2026-10-08,8.00,0.00,1364.00,312.44,1051.56,84.57,160.00,0.00,19.78,",
    "V1001,20260001,1,2026-10-04,2026-10-10,Cash,Nguyen,Tran,,5678,E02,Female,A-IN,200,201,9999-01-01,N,34.10,51.15,2026-10-09,8.00,0.00,1364.00,312.44,1051.56,84.57,160.00,0.00,19.78,",
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
    SAMPLE_CSV: SAMPLE_CSV,
    TEMPLATE_CSV: REQUIRED.join(",") + "\n"
  };
});
