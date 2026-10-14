/*
  payroll-xml column mapper for the browser. MIT license.
  Takes the file a payroll system already exports, with its own column names,
  and writes the CSV layout docs/prlxml.js converts. Pure functions, no DOM, no network.
  tests/mapper_cases.js runs it under Node.
*/
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.prlmap = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // The column list docs/prlxml.js reads. tests/mapper_cases.js checks the two stay equal.
  var CANON = [
    "vendor_id", "contract_id", "payroll_number", "period_begin", "period_end", "fringe_type",
    "last_name", "first_name", "middle_initial", "ssn", "employee_id", "gender", "ethnicity",
    "craft_code", "labor_class", "project_id", "apprentice", "st_rate", "ot_rate",
    "work_date", "st_hours", "ot_hours",
    "gross_pay", "total_deductions", "net_pay", "fica", "federal_tax", "state_tax", "medicare", "other_deductions",
    "project_gross", "lump_sum", "apprentice_id", "apprentice_pct",
    "health_rate", "vacation_rate", "apprenticeship_rate", "pension_rate", "other1_rate", "other2_rate", "fringe_benefits",
    "health_program", "vacation_program", "apprenticeship_program", "pension_program", "other1_program", "other2_program"
  ];
  var MONEY_FIELDS = ["gross_pay", "total_deductions", "net_pay", "fica", "federal_tax", "state_tax", "medicare", "project_gross", "lump_sum"];
  var TAX_FIELDS = ["fica", "federal_tax", "state_tax", "medicare"];
  var PERSON_FIELDS = ["last_name", "first_name", "middle_initial", "ssn", "employee_id", "gender", "ethnicity"];
  // What the New York State DOL file needs about a worker on top of that.
  var NY_PERSON_FIELDS = ["date_of_birth", "address1", "address2", "city", "home_state", "zip"];
  // What New York needs about a classification: its work category name and the fringe rates per hour.
  var NY_FRINGES = ["health", "vacation", "training", "pension", "other"];
  // The CSV layout docs/nydol.js reads. tests/mapper_cases.js checks it covers nydol's required columns.
  var NY_COLS = ["prc_number", "week_ending", "last_name", "first_name", "middle_name", "ssn_last4", "date_of_birth", "apprentice",
    "address1", "address2", "city", "state", "zip", "country", "gross_earnings", "net_wages", "deductions",
    "work_category", "st_rate", "ot_rate", "health", "vacation", "training", "pension", "other", "other_explanation",
    "work_date", "st_hours", "ot_hours"];

  function MapError(problems) {
    this.name = "MapError";
    this.problems = Array.isArray(problems) ? problems : [String(problems)];
    this.message = this.problems.join("\n");
  }
  MapError.prototype = Object.create(Error.prototype);
  MapError.prototype.constructor = MapError;

  function own(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // ---- reading the file ----

  function sniffDelimiter(text) {
    var counts = { ",": 0, "\t": 0, ";": 0, "|": 0 };
    var inQuotes = false;
    var lines = 0;
    for (var i = 0; i < text.length && lines < 10; i++) {
      var c = text[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (!inQuotes && own(counts, c)) counts[c]++;
      else if (!inQuotes && c === "\n") lines++;
    }
    var best = ",";
    Object.keys(counts).forEach(function (d) {
      if (counts[d] > counts[best]) best = d;
    });
    return best;
  }

  // Every line becomes a record, blank ones too, so a record's position is its row number in the file.
  function splitRecords(text, delim) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var atStart = true;
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
        i++;
        continue;
      }
      if (c === delim) {
        row.push(field);
        field = "";
        atStart = true;
        i++;
        continue;
      }
      if (c === "\r" || c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        atStart = true;
        if (c === "\r" && text[i + 1] === "\n") i++;
        i++;
        continue;
      }
      field += c;
      atStart = false;
      i++;
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function filledCells(rec) {
    var k = 0;
    for (var i = 0; i < rec.length; i++) if (rec[i].trim() !== "") k++;
    return k;
  }

  function looksLikeData(s) {
    s = s.trim();
    return s !== "" && (parseMoney(s) !== null || parseDate(s) !== null);
  }

  // Reports often start with a title and the company name. The header is the first row that is
  // about as wide as the widest row and holds words, not numbers or dates.
  function findHeader(recs) {
    var top = Math.min(recs.length, 25);
    var widest = 0;
    var i;
    for (i = 0; i < top; i++) widest = Math.max(widest, filledCells(recs[i]));
    var need = Math.max(2, Math.ceil(widest * 0.7));
    var firstWide = -1;
    for (i = 0; i < top; i++) {
      var filled = filledCells(recs[i]);
      if (filled < need) continue;
      if (firstWide < 0) firstWide = i;
      var data = 0;
      for (var j = 0; j < recs[i].length; j++) if (looksLikeData(recs[i][j])) data++;
      if (data / filled < 0.5) return i;
    }
    // No row of words. Day columns named by date look like data, so take the first wide row.
    return firstWide;
  }

  function colLetter(i) {
    var s = "";
    i += 1;
    while (i > 0) {
      var r = (i - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  // headerRow is the row number of the column names, or 0 to find it.
  function readTable(text, headerRow) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var delim = sniffDelimiter(text);
    var recs = splitRecords(text, delim);
    var hr = headerRow ? headerRow - 1 : findHeader(recs);
    if (hr < 0 || hr >= recs.length || filledCells(recs[hr]) === 0) {
      throw new MapError(["Cannot find the row of column names in this file. It needs one row of names above the data."]);
    }
    var width = 0;
    for (var k = hr; k < recs.length; k++) width = Math.max(width, recs[k].length);
    var headers = [];
    var index = {};
    for (var j = 0; j < width; j++) {
      var h = (recs[hr][j] || "").replace(/\s+/g, " ").trim();
      if (h === "") h = "Column " + colLetter(j);
      var base = h;
      var dup = 2;
      while (own(index, h)) h = base + " (" + dup++ + ")";
      index[h] = j;
      headers.push(h);
    }
    var rows = [];
    for (var i = hr + 1; i < recs.length; i++) {
      if (filledCells(recs[i]) === 0) continue;
      rows.push({ n: i + 1, cells: recs[i] });
    }
    return { headers: headers, index: index, rows: rows, headerRow: hr + 1, delimiter: delim };
  }

  function cellAt(row, idx) {
    var v = row.cells[idx];
    return v === undefined ? "" : v.replace(/\s+/g, " ").trim();
  }

  // ---- cell values ----

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function realDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    var t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
    return y + "-" + pad2(m) + "-" + pad2(d);
  }

  // 2026-10-05, 10/5/2026, 10/5/26, 10-05-2026, each with or without a time after it. Month comes first, the US way.
  function parseDate(value) {
    var s = String(value || "").trim();
    var m = /^([0-9]{4})[-\/]([0-9]{1,2})[-\/]([0-9]{1,2})(?:[T ].*)?$/.exec(s);
    if (m) return realDate(+m[1], +m[2], +m[3]);
    m = /^([0-9]{1,2})[-\/]([0-9]{1,2})[-\/]([0-9]{4}|[0-9]{2})(?: .*)?$/.exec(s);
    if (m) return realDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
    return null;
  }

  function addDays(iso, n) {
    var p = iso.split("-");
    var t = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
    return t.getUTCFullYear() + "-" + pad2(t.getUTCMonth() + 1) + "-" + pad2(t.getUTCDate());
  }

  // A number as a whole count of the smallest unit: places 2 gives cents, places 4 gives ten-thousandths.
  // null when the cell is not a number. A blank cell is "".
  // Reads $1,234.50, (12.00) and 12.00- as well as plain numbers. Halves round up.
  function parseScaled(value, places) {
    var s = String(value === undefined || value === null ? "" : value).trim();
    if (s === "") return "";
    var neg = false;
    if (/^\(.*\)$/.test(s)) {
      neg = true;
      s = s.slice(1, -1);
    }
    s = s.replace(/[$\s]/g, "");
    // A comma is a thousands mark only, in groups of three. 8,0 is not 80: it is not a number.
    if (s.indexOf(",") >= 0) {
      if (!/^[+-]?[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]*)?-?$/.test(s)) return null;
      s = s.replace(/,/g, "");
    }
    if (/-$/.test(s)) {
      neg = !neg;
      s = s.slice(0, -1);
    }
    var m = /^([+-])?(?:([0-9]{1,12})(?:\.([0-9]*))?|\.([0-9]+))$/.exec(s);
    if (!m) return null;
    if (m[1] === "-") neg = !neg;
    var frac = (m[3] !== undefined ? m[3] : (m[4] || "")) + "00000";
    var n = parseInt(m[2] || "0", 10) * Math.pow(10, places) + parseInt(frac.slice(0, places), 10) + (frac.charCodeAt(places) >= 53 ? 1 : 0);
    return neg && n !== 0 ? -n : n;
  }

  // Whole cents.
  function parseMoney(value) {
    return parseScaled(value, 2);
  }

  // An hourly rate in ten-thousandths of a dollar. The converter keeps 3 places on a straight time
  // rate and 4 on an overtime rate, so the mapper must not round a rate to cents on the way.
  function parseRate(value) {
    return parseScaled(value, 4);
  }

  // A rate back to text: at least two places, more only when the rate has them.
  function fmtRate(v) {
    var neg = v < 0;
    var mag = Math.abs(v);
    var frac = String(mag % 10000);
    while (frac.length < 4) frac = "0" + frac;
    frac = frac.replace(/0{1,2}$/, "");
    return (neg ? "-" : "") + Math.floor(mag / 10000) + "." + frac;
  }

  // Hours, in ticks of 1/360000 of an hour, so clock times and decimals add up exactly and are
  // rounded once, when a day is written. Reads 8, 8.5, 7.75 and clock style 7:45 or 7:45:30.
  // A blank cell is 0. null when unreadable.
  function parseHours(value) {
    var s = String(value === undefined || value === null ? "" : value).trim();
    if (s === "") return 0;
    var m = /^(-)?([0-9]{1,3}):([0-5][0-9])(?::([0-5][0-9]))?$/.exec(s);
    if (m) {
      var t = (+m[2] * 3600 + +m[3] * 60 + (m[4] ? +m[4] : 0)) * 100;
      return m[1] ? -t : t;
    }
    var d = /^([+-])?(?:([0-9]{1,6})(?:\.([0-9]*))?|\.([0-9]+))$/.exec(s);
    if (!d) return null;
    var frac = (d[3] !== undefined ? d[3] : (d[4] || "")) + "00000";
    var tenThousandths = parseInt(d[2] || "0", 10) * 10000 + parseInt(frac.slice(0, 4), 10) + (frac.charCodeAt(4) >= 53 ? 1 : 0);
    return (d[1] === "-" ? -1 : 1) * tenThousandths * 36;
  }

  // Ticks to hours with two places. Halves round up.
  function fmtHours(ticks) {
    var mag = Math.abs(ticks);
    var h = Math.floor((mag + 1800) / 3600);
    return (ticks < 0 && h !== 0 ? "-" : "") + Math.floor(h / 100) + "." + pad2(h % 100);
  }

  function fmt(cents) {
    var neg = cents < 0;
    var mag = Math.abs(cents);
    return (neg ? "-" : "") + Math.floor(mag / 100) + "." + pad2(mag % 100);
  }

  var SUFFIX = /^(jr|sr|ii|iii|iv)\.?$/i;

  function isInitial(t) {
    return /^[A-Za-z]\.?$/.test(t);
  }

  // order "last_first" reads "Garcia, Luis A" and "Garcia Luis A". "first_last" reads "Luis A Garcia".
  function splitName(full, order) {
    var s = String(full || "").replace(/\s+/g, " ").trim();
    var out = { last: "", first: "", mi: "" };
    if (!s) return out;
    var toks;
    if (order === "first_last") {
      toks = s.split(" ");
      out.first = toks.shift() || "";
      if (toks.length > 1 && isInitial(toks[0])) out.mi = toks.shift().charAt(0);
      out.last = toks.join(" ");
      return out;
    }
    var comma = s.indexOf(",");
    if (comma >= 0) {
      out.last = s.slice(0, comma).trim();
      toks = s.slice(comma + 1).replace(/,/g, " ").trim().split(" ").filter(function (t) { return t !== ""; });
    } else {
      toks = s.split(" ");
      out.last = toks.shift() || "";
    }
    // "Garcia, Luis A, Jr." keeps the Jr with the last name
    if (toks.length > 1 && SUFFIX.test(toks[toks.length - 1])) out.last += " " + toks.pop().replace(/\.$/, "");
    if (toks.length > 1 && isInitial(toks[toks.length - 1])) out.mi = toks.pop().charAt(0);
    out.first = toks.join(" ");
    return out;
  }

  function nameKey(last, first) {
    return "name:" + last.toLowerCase() + "|" + first.toLowerCase();
  }

  // ---- guessing the columns ----

  function norm(h) {
    return String(h).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // Header words seen in payroll and timesheet exports and on the state spreadsheets.
  var SYNONYMS = {
    employee_id: ["employeeid", "empid", "employeenumber", "employeeno", "empno", "empnum", "employeenum", "file", "filenumber", "fileno", "workerid", "payrollid", "employeetimeclockid", "badge", "badgenumber"],
    full_name: ["employee", "employeename", "name", "fullname", "sourcename", "employeevendor", "worker", "workername", "selectemployee", "namelastfirstmiddleinitial"],
    last_name: ["lastname", "employeelastname", "last", "lname", "surname"],
    first_name: ["firstname", "employeefirstname", "first", "fname"],
    middle_initial: ["middleinitial", "mi", "middlename", "middle"],
    ssn: ["ssn", "socialsecurityno", "socialsecuritynumber", "ssnlast4", "last4ssn", "last4", "socsecno", "ssno", "partialssn"],
    gender: ["gender", "sex"],
    ethnicity: ["ethnicity", "race", "ethnic", "raceethnicity", "eeo"],
    classification: ["classification", "workclassification", "laborclass", "laborcode", "laborclassification", "craft", "trade", "jobclass", "jobclassification", "jobtitle", "title", "position", "workcategory", "paylevel", "payclass", "class"],
    craft_code: ["craftcode"],
    job: ["job", "jobnumber", "jobno", "jobname", "project", "projectname", "projectnumber", "projectno", "customer", "customername", "customerjob", "customerjobadm", "contract"],
    project_id: ["projectid"],
    week_ending: ["weekending", "weekendingdate", "weekend", "weekenddate", "periodend", "periodending", "periodenddate", "payperiodend", "payperiodenddate", "payperiodending", "forweekending", "lastdateofworkweek", "payrollendingdate", "enddate"],
    work_date: ["date", "workdate", "linedate", "transactiondate", "ticketdate", "activitydate", "day", "localdate", "dateworked", "timedate"],
    st_hours: ["reghours", "regularhours", "sthours", "straighttimehours", "straighthours", "st", "regular", "reg", "standardtimehours", "workedstandardtime", "reghrs"],
    ot_hours: ["othours", "overtimehours", "ot", "overtime", "othrs"],
    hours: ["hours", "hrs", "units", "qty", "quantity", "duration", "payhours"],
    pay_type: ["paytype", "payid", "earningscode", "earningcode", "paycomponent", "payrollitem", "payrollwageitemname", "payitem", "paycode", "earningstype", "hourstype", "hourtype"],
    st_rate: ["strate", "strateofpay", "straighttimerate", "straightrate", "regularrate", "regrate", "basicrate", "baserate"],
    ot_rate: ["otrate", "otrateofpay", "overtimerate"],
    rate: ["rate", "payrate", "hourlyrate", "rateofpay", "temprate"],
    gross_pay: ["grosspay", "gross", "grossearnings", "grosswages", "payperiodgrosspay", "totalgross", "totalearnings", "grossamount"],
    project_gross: ["projectgross", "grossprojectamountearned", "grossthisproject"],
    fica: ["fica", "socialsecurity", "ssamt", "socsec", "oasdi", "socialsecurityemployee", "ficaee", "socialsecuritytax"],
    federal_tax: ["federalwithholding", "federalincometax", "fit", "fitamt", "fedwithholding", "fedtax", "federaltax", "fwt", "federal", "fedwh"],
    state_tax: ["statewithholding", "stateincometax", "sit", "sitamt", "statetax", "swt", "statewh"],
    medicare: ["medicare", "medicareamt", "medicareemployee", "medicareee", "medicaretax"],
    total_deductions: ["totaldeductions", "deductions", "totaldeduction", "totalded"],
    net_pay: ["netpay", "net", "netwages", "netpaid", "netcheck", "netamount", "takehome"],
    apprentice: ["apprentice", "isapprentice"],
    apprentice_id: ["apprenticeid", "apprenticeojtid"],
    apprentice_pct: ["apprenticepct", "apprenticepercentage", "apprenticeojtpercentage", "apprenticewagepercentage"],
    // the worker's home address and birth date, which the New York file carries
    date_of_birth: ["dateofbirth", "dob", "birthdate", "birthday", "employeedob", "employeebirthdate"],
    address1: ["address", "address1", "addressline1", "street", "streetaddress", "homeaddress", "employeeaddress", "mailingaddress", "addr1"],
    address2: ["address2", "addressline2", "apt", "aptsuite", "suite", "unit", "addr2"],
    city: ["city", "town", "employeecity", "homecity"],
    home_state: ["state", "homestate", "employeestate", "addressstate", "stateprovince", "province"],
    zip: ["zip", "zipcode", "postalcode", "postal", "zip5", "employeezip", "homezip"]
  };
  // Fields a pay totals file can supply.
  var TOTALS_FILE_FIELDS = ["employee_id", "full_name", "last_name", "first_name", "gross_pay", "total_deductions", "net_pay", "fica", "federal_tax", "state_tax", "medicare"];

  var DAY_WORDS = [["sun", "sunday"], ["mon", "monday"], ["tue", "tues", "tuesday"], ["wed", "weds", "wednesday"], ["thu", "thur", "thurs", "thursday"], ["fri", "friday"], ["sat", "saturday"]];

  // A date somewhere in a header: "10/05/2026", "Mon 10/5/26", "2026-10-05 OT".
  function headerDate(h) {
    var m = /([0-9]{4}-[0-9]{1,2}-[0-9]{1,2}|[0-9]{1,2}[-\/][0-9]{1,2}[-\/](?:[0-9]{4}|[0-9]{2}))/.exec(String(h));
    return m ? parseDate(m[1]) : null;
  }

  // The weekday a header names, 0 for Sunday to 6 for Saturday, or -1.
  function headerWeekday(h) {
    var words = String(h).toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w !== ""; });
    for (var i = 0; i < words.length; i++) {
      for (var d = 0; d < 7; d++) if (DAY_WORDS[d].indexOf(words[i]) >= 0) return d;
    }
    return -1;
  }

  function weekdayOf(iso) {
    var p = iso.split("-");
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
  }

  // Is this header a day of the week or a date? Returns { ot: bool } or null.
  function dayHeader(h) {
    if (headerDate(h) === null && headerWeekday(h) < 0) return null;
    var ot = /\b(ot|overtime|over time)\b/.test(String(h).toLowerCase().replace(/\./g, ""));
    return { ot: ot };
  }

  function guessPayType(value) {
    var v = String(value).trim().toLowerCase();
    if (v === "") return null;
    var w = v.replace(/\./g, "");
    if (/^(o|ot[0-9]?|dt)$/.test(w) || /overtime|over time|double ?time|time and a half|\bot\b/.test(w) || /1\.5/.test(v)) return "ot";
    if (/^(s|st|r|reg)$/.test(w) || /regular|straight|standard time|hourly/.test(w)) return "st";
    return null;
  }

  function emptySetup() {
    return {
      version: 1,
      target: "aashto",
      days: "down",
      payType: "columns",
      nameOrder: "last_first",
      cols: {},
      dayCols: { st: ["", "", "", "", "", "", ""], ot: ["", "", "", "", "", "", ""] },
      otherDeductionCols: [],
      payTypes: {},
      otRule: "column",
      deductionsRule: "column",
      netRule: "column",
      rowAmounts: "repeat",
      jobs: [],
      payroll: { vendor_id: "", contract_id: "", payroll_number: "", period_begin: "", fringe_type: "", project_id: "", prc_number: "" },
      totals: { nameOrder: "last_first", cols: {}, otherDeductionCols: [] },
      people: {},
      classes: {}
    };
  }

  function str(v) {
    return typeof v === "string" ? v : (typeof v === "number" ? String(v) : "");
  }

  function pick(v, allowed, fallback) {
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }

  function strMap(obj) {
    var out = {};
    if (obj && typeof obj === "object") {
      Object.keys(obj).forEach(function (k) {
        if (typeof obj[k] === "string" || typeof obj[k] === "number") out[k] = str(obj[k]);
      });
    }
    return out;
  }

  function seven(arr) {
    var out = [];
    for (var i = 0; i < 7; i++) out.push(Array.isArray(arr) ? str(arr[i]) : "");
    return out;
  }

  // A setup file is something a person saved and may have edited. Read it defensively.
  function normalizeSetup(raw) {
    var s = emptySetup();
    if (!raw || typeof raw !== "object") return s;
    s.target = pick(raw.target, ["aashto", "ny"], "aashto");
    s.days = pick(raw.days, ["down", "across"], "down");
    s.payType = pick(raw.payType, ["columns", "code"], "columns");
    s.nameOrder = pick(raw.nameOrder, ["last_first", "first_last"], "last_first");
    s.cols = strMap(raw.cols);
    if (raw.dayCols && typeof raw.dayCols === "object") s.dayCols = { st: seven(raw.dayCols.st), ot: seven(raw.dayCols.ot) };
    if (Array.isArray(raw.otherDeductionCols)) s.otherDeductionCols = raw.otherDeductionCols.map(str).filter(Boolean);
    if (raw.payTypes && typeof raw.payTypes === "object") {
      Object.keys(raw.payTypes).forEach(function (k) {
        if (["st", "ot", "skip"].indexOf(raw.payTypes[k]) >= 0) s.payTypes[k] = raw.payTypes[k];
      });
    }
    s.otRule = pick(raw.otRule, ["column", "x1.5"], "column");
    s.deductionsRule = pick(raw.deductionsRule, ["column", "sum"], "column");
    s.netRule = pick(raw.netRule, ["column", "calc"], "column");
    s.rowAmounts = pick(raw.rowAmounts, ["repeat", "sum"], "repeat");
    if (Array.isArray(raw.jobs)) s.jobs = raw.jobs.map(str);
    var p = strMap(raw.payroll);
    Object.keys(s.payroll).forEach(function (k) { if (own(p, k)) s.payroll[k] = p[k].trim(); });
    if (raw.totals && typeof raw.totals === "object") {
      s.totals.nameOrder = pick(raw.totals.nameOrder, ["last_first", "first_last"], "last_first");
      s.totals.cols = strMap(raw.totals.cols);
      if (Array.isArray(raw.totals.otherDeductionCols)) s.totals.otherDeductionCols = raw.totals.otherDeductionCols.map(str).filter(Boolean);
    }
    if (raw.people && typeof raw.people === "object") {
      Object.keys(raw.people).forEach(function (k) { s.people[k] = strMap(raw.people[k]); });
    }
    if (raw.classes && typeof raw.classes === "object") {
      Object.keys(raw.classes).forEach(function (k) { s.classes[k] = strMap(raw.classes[k]); });
    }
    return s;
  }

  function guessCols(table, fields) {
    var cols = {};
    var taken = {};
    fields.forEach(function (f) {
      var syn = SYNONYMS[f];
      for (var i = 0; i < table.headers.length; i++) {
        var h = table.headers[i];
        if (own(taken, h)) continue;
        if (syn.indexOf(norm(h)) >= 0) {
          cols[f] = h;
          taken[h] = true;
          return;
        }
      }
    });
    return cols;
  }

  // A first pass at the setup for a payroll export. The person checks it on the page.
  function guess(table) {
    var s = emptySetup();
    var fields = Object.keys(SYNONYMS);
    s.cols = guessCols(table, fields);
    var c = s.cols;

    var st = [];
    var ot = [];
    table.headers.forEach(function (h) {
      var d = dayHeader(h);
      if (!d) return;
      (d.ot ? ot : st).push(h);
    });
    if (st.length === 7) {
      // seven weekday or date columns: the days run across the page
      s.days = "across";
      s.dayCols.st = st;
      if (ot.length === 7) s.dayCols.ot = ot;
      delete c.work_date;
      delete c.st_hours;
      delete c.ot_hours;
      delete c.hours;
    }

    if (c.pay_type && (s.days === "across" || (c.hours && !(c.st_hours && c.ot_hours)))) {
      s.payType = "code";
    }
    if (s.payType === "code") {
      delete c.st_hours;
      delete c.ot_hours;
      delete c.st_rate;
      delete c.ot_rate;
      var seen = {};
      var idx = table.index[c.pay_type];
      table.rows.forEach(function (row) {
        var v = cellAt(row, idx);
        if (own(seen, v)) return;
        seen[v] = true;
        var g = guessPayType(v);
        if (g) s.payTypes[v] = g;
      });
    } else {
      // one hours column and no pay type column: every hour is straight time
      if (!c.st_hours && c.hours && s.days === "down") c.st_hours = c.hours;
      delete c.hours;
      delete c.pay_type;
      // one rate column with separate hours columns is the straight time rate
      if (!c.st_rate && c.rate) c.st_rate = c.rate;
      delete c.rate;
    }
    if (c.last_name || c.first_name) delete c.full_name;
    if (s.days !== "across") delete c.week_ending;

    if (c.full_name) {
      var withComma = 0;
      var total = 0;
      var nidx = table.index[c.full_name];
      table.rows.slice(0, 50).forEach(function (row) {
        var v = cellAt(row, nidx);
        if (!v) return;
        total++;
        if (v.indexOf(",") >= 0) withComma++;
      });
      s.nameOrder = total && withComma * 2 < total ? "first_last" : "last_first";
    }

    // The pay week is not guessed. A file of Monday to Friday rows does not say the week starts on Sunday.
    return s;
  }

  function guessTotals(table) {
    var cols = guessCols(table, TOTALS_FILE_FIELDS);
    if (cols.last_name || cols.first_name) delete cols.full_name;
    var order = "last_first";
    if (cols.full_name) {
      var withComma = 0;
      var total = 0;
      var idx = table.index[cols.full_name];
      table.rows.slice(0, 50).forEach(function (row) {
        var v = cellAt(row, idx);
        if (!v) return;
        total++;
        if (v.indexOf(",") >= 0) withComma++;
      });
      if (total && withComma * 2 < total) order = "first_last";
    }
    return { nameOrder: order, cols: cols, otherDeductionCols: [] };
  }

  // ---- gathering the rows into workers, labor lines and days ----

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  // "Totals", "Grand total", "Subtotal for ..." in the name or ID cell marks a row of sums, not a worker.
  var TOTAL_ROW = /^(grand\s+|report\s+)?(sub)?totals?\b/i;

  function gather(table, setup) {
    var c = setup.cols;
    var problems = [];
    var notes = [];
    var has = function (k) { return !!c[k] && own(table.index, c[k]); };
    var get = function (row, k) { return has(k) ? cellAt(row, table.index[c[k]]) : ""; };
    var across = setup.days === "across";
    var coded = setup.payType === "code";
    var begin = parseDate(setup.payroll.period_begin);
    var end = begin ? addDays(begin, 6) : null;

    var emps = new Map();
    var prev = null;
    var seen = { payTypes: {}, jobs: {}, classes: {} };
    var undecided = {};
    var count = { otherJobs: 0, skippedTypes: 0, outside: 0, noDate: 0, totalRows: 0, kept: 0, inherited: 0, stacked: 0 };
    var prevJob = "";
    var minDate = null;
    var maxDate = null;
    var said = {};
    var once = function (msg) {
      if (!own(said, msg)) {
        said[msg] = true;
        problems.push(msg);
      }
    };

    var hoursOf = function (row, header, n) {
      if (!header || !own(table.index, header)) return 0;
      var raw = cellAt(row, table.index[header]);
      var h = parseHours(raw);
      if (h === null) {
        problems.push("row " + n + ": column \"" + header + "\" should hold hours, but has \"" + raw + "\"");
        return 0;
      }
      return h;
    };
    var moneyOf = function (row, header, n, asRate) {
      if (!header || !own(table.index, header)) return "";
      var raw = cellAt(row, table.index[header]);
      var m = asRate ? parseRate(raw) : parseMoney(raw);
      if (m === null) {
        problems.push("row " + n + ": column \"" + header + "\" should hold an amount, but has \"" + raw + "\"");
        return "";
      }
      return m;
    };

    if (!across && !has("work_date")) once("Pick the column that holds the date worked.");
    if (across && setup.dayCols.st.filter(function (h) { return h && own(table.index, h); }).length !== 7) once("Pick all seven day columns, in order from the first day of the pay week.");

    // Days across: which date each day column is. A column named for a date or a weekday goes on that
    // day, whatever order the columns are in. Any other column goes by position from the first day.
    var dayDates = { st: [], ot: [] };
    if (across) {
      ["st", "ot"].forEach(function (kindOfCol) {
        var landed = {};
        for (var k = 0; k < 7; k++) {
          var h = setup.dayCols[kindOfCol][k];
          var date = begin ? addDays(begin, k) : "day " + (k + 1);
          if (h && begin) {
            var named = headerDate(h);
            var wd = headerWeekday(h);
            if (named) {
              date = named;
              if (named < begin || named > end) once("The day column \"" + h + "\" is outside the pay week, " + begin + " to " + end + ". Check the first day of the pay week.");
            } else if (wd >= 0) {
              date = addDays(begin, (wd - weekdayOf(begin) + 7) % 7);
            }
            if (own(landed, date)) once("Two day columns land on the same day, " + date + ": \"" + landed[date] + "\" and \"" + h + "\".");
            landed[date] = h;
          }
          dayDates[kindOfCol].push(date);
        }
      });
    }
    if (coded) {
      if (!has("pay_type")) once("Pick the column that says what kind of pay each row is.");
      if (!across && !has("hours")) once("Pick the column that holds the hours.");
    } else if (!across && !has("st_hours")) {
      once("Pick the column that holds the straight time hours.");
    }
    if (!has("employee_id") && !has("full_name") && !has("last_name")) once("Pick the column that holds the worker's name, or the worker's ID.");

    table.rows.forEach(function (row) {
      var n = row.n;
      var id = get(row, "employee_id");
      var last = get(row, "last_name");
      var first = get(row, "first_name");
      var mi = get(row, "middle_initial");
      var full = get(row, "full_name");
      if (!last && !first && full) {
        var parts = splitName(full, setup.nameOrder);
        last = parts.last;
        first = parts.first;
        if (!mi) mi = parts.mi;
      }
      var who;
      var inherited = false;
      if (!id && !last && !first) {
        who = prev;
        inherited = true;
      } else if (TOTAL_ROW.test(full || last) || TOTAL_ROW.test(id)) {
        count.totalRows++;
        prev = null;
        return;
      } else {
        who = { id: id, last: last, first: first, mi: mi.replace(/\./g, ""), ssn: get(row, "ssn"), gender: get(row, "gender"), ethnicity: get(row, "ethnicity"), extra: {} };
        NY_PERSON_FIELDS.forEach(function (f) { who.extra[f] = get(row, f); });
        prev = who;
      }

      var job = get(row, "job");
      if (has("job")) {
        // a row that leaves the name and the job blank belongs to the row above it
        if (inherited && job === "") job = prevJob;
        else if (!inherited) prevJob = job;
        seen.jobs[job] = (seen.jobs[job] || 0) + 1;
        if (setup.jobs.length && setup.jobs.indexOf(job) < 0) {
          count.otherJobs++;
          return;
        }
      }

      var kind = null;
      if (coded && has("pay_type")) {
        var pt = get(row, "pay_type");
        seen.payTypes[pt] = (seen.payTypes[pt] || 0) + 1;
        if (own(setup.payTypes, pt)) kind = setup.payTypes[pt];
        else undecided[pt] = true;
      }

      var entries = [];
      var i;
      if (across) {
        if (has("week_ending")) {
          var wraw = get(row, "week_ending");
          var we = parseDate(wraw);
          if (we) {
            if (minDate === null || addDays(we, -6) < minDate) minDate = addDays(we, -6);
            if (maxDate === null || we > maxDate) maxDate = we;
            if (begin && we !== end) {
              count.outside++;
              return;
            }
          } else if (wraw !== "") {
            problems.push("row " + n + ": cannot read the date \"" + wraw + "\" in column \"" + c.week_ending + "\"");
            return;
          }
        }
        for (i = 0; i < 7; i++) {
          var sv = hoursOf(row, setup.dayCols.st[i], n);
          if (!coded) {
            entries.push({ date: dayDates.st[i], st: sv, ot: 0 });
            if (setup.dayCols.ot[i]) entries.push({ date: dayDates.ot[i], st: 0, ot: hoursOf(row, setup.dayCols.ot[i], n) });
          } else if (kind === "st") entries.push({ date: dayDates.st[i], st: sv, ot: 0 });
          else if (kind === "ot") entries.push({ date: dayDates.st[i], st: 0, ot: sv });
        }
      } else {
        var raw = get(row, "work_date");
        var d = parseDate(raw);
        var st = 0;
        var ot = 0;
        if (coded) {
          var h = hoursOf(row, c.hours, n);
          if (kind === "st") st = h;
          else if (kind === "ot") ot = h;
        } else {
          st = hoursOf(row, c.st_hours, n);
          ot = hoursOf(row, c.ot_hours, n);
        }
        if (!d) {
          if (raw !== "" && has("work_date")) problems.push("row " + n + ": cannot read the date \"" + raw + "\" in column \"" + c.work_date + "\"");
          else if (st !== 0 || ot !== 0) count.noDate++;
          return;
        }
        if (minDate === null || d < minDate) minDate = d;
        if (maxDate === null || d > maxDate) maxDate = d;
        if (begin && (d < begin || d > end)) {
          count.outside++;
          return;
        }
        if (!coded || kind === "st" || kind === "ot") entries.push({ date: d, st: st, ot: ot });
      }
      if (coded && kind === "skip") {
        count.skippedTypes++;
        return;
      }

      if (!who) {
        var any = entries.some(function (e) { return e.st !== 0 || e.ot !== 0; });
        if (any) problems.push("row " + n + ": hours with no worker name or ID");
        return;
      }
      count.kept++;
      if (inherited) count.inherited++;

      var key = who.id ? "id:" + who.id : nameKey(who.last, who.first);
      var emp = emps.get(key);
      if (!emp) {
        emp = { key: key, id: who.id, last: who.last, first: who.first, mi: who.mi, ssn: who.ssn, gender: who.gender, ethnicity: who.ethnicity, extra: {}, row: n, lines: new Map(), lastLine: null };
        NY_PERSON_FIELDS.forEach(function (f) { emp.extra[f] = who.extra[f]; });
        emps.set(key, emp);
      } else {
        if (!inherited) {
          [["ssn", "SSNs"], ["gender", "genders"], ["ethnicity", "ethnicities"], ["mi", "middle initials"]].forEach(function (f) {
            var a = f[0] === "ssn" ? emp.ssn.replace(/[\s-]/g, "") : emp[f[0]].toLowerCase();
            var b = f[0] === "ssn" ? who.ssn.replace(/[\s-]/g, "") : who[f[0]].toLowerCase();
            if (a && b && a !== b) {
              once("Rows " + emp.row + " and " + n + " look like two workers with the same " + (who.id ? "ID" : "name") + ", " + (who.id || (who.last + ", " + who.first)) + ", but different " + f[1] + ". The page tells workers apart by ID, or by name when there is no ID. " + (who.id ? "Fix the file." : "Pick a worker ID column so they stay apart."));
            }
          });
        }
        ["last", "first", "mi", "ssn", "gender", "ethnicity"].forEach(function (f) {
          if (!emp[f] && who[f]) emp[f] = who[f];
        });
        NY_PERSON_FIELDS.forEach(function (f) {
          if (!emp.extra[f] && who.extra[f]) emp.extra[f] = who.extra[f];
        });
      }

      var cls = get(row, "classification");
      var craft = get(row, "craft_code");
      var labor = get(row, "labor_class");
      var proj = has("project_id") ? get(row, "project_id") : setup.payroll.project_id;
      if (emp.lastLine && (inherited || (!cls && !craft && !labor))) {
        // a row that leaves the name or the classification blank belongs to the line above it
        if (!cls) cls = emp.lastLine.cls;
        if (!craft) craft = emp.lastLine.craft;
        if (!labor) labor = emp.lastLine.labor;
        if (has("project_id") && !proj) proj = emp.lastLine.project;
      }
      if (has("classification")) seen.classes[cls] = (seen.classes[cls] || 0) + 1;
      var lkey = cls + "\u0001" + craft + "\u0001" + labor + "\u0001" + proj;
      var line = emp.lines.get(lkey);
      if (line && across && !coded) count.stacked++;
      if (!line) {
        line = { cls: cls, craft: craft, labor: labor, project: proj, row: n, days: new Map(), money: {}, moneyRow: {}, other: {}, text: {} };
        emp.lines.set(lkey, line);
      }
      emp.lastLine = line;
      var label = (emp.last || emp.id) + (emp.first ? ", " + emp.first : "");

      entries.forEach(function (e) {
        var day = line.days.get(e.date);
        if (!day) {
          day = { st: 0, ot: 0 };
          line.days.set(e.date, day);
        }
        day.st += e.st;
        day.ot += e.ot;
      });

      var setOnce = function (field, value, shown, show) {
        if (value === "") return;
        show = show || fmt;
        if (!own(line.money, field)) {
          line.money[field] = value;
          line.moneyRow[field] = n;
        } else if (line.money[field] !== value) {
          problems.push("row " + n + ": " + shown + " is " + show(value) + " here but " + show(line.money[field]) + " on row " + line.moneyRow[field] + ", for " + label + ". One worker on one classification has one value for the week.");
        }
      };
      if (coded) {
        var r = moneyOf(row, c.rate, n, true);
        if (kind === "st") setOnce("st_rate", r, "the straight time rate", fmtRate);
        else if (kind === "ot") setOnce("ot_rate", r, "the overtime rate", fmtRate);
      } else {
        setOnce("st_rate", moneyOf(row, c.st_rate, n, true), "the straight time rate", fmtRate);
        setOnce("ot_rate", moneyOf(row, c.ot_rate, n, true), "the overtime rate", fmtRate);
      }
      MONEY_FIELDS.forEach(function (f) {
        if (!has(f)) return;
        var v = moneyOf(row, c[f], n);
        if (v === "") return;
        if (setup.rowAmounts === "sum") line.money[f] = (own(line.money, f) ? line.money[f] : 0) + v;
        else setOnce(f, v, "\"" + c[f] + "\"");
      });
      setup.otherDeductionCols.forEach(function (h) {
        if (!own(table.index, h)) return;
        var v = moneyOf(row, h, n);
        if (v === "") return;
        if (setup.rowAmounts === "sum") line.other[h] = (own(line.other, h) ? line.other[h] : 0) + v;
        else if (!own(line.other, h)) line.other[h] = v;
        else if (line.other[h] !== v) problems.push("row " + n + ": \"" + h + "\" is " + fmt(v) + " here but " + fmt(line.other[h]) + " on an earlier row, for " + label + ".");
      });
      ["apprentice", "apprentice_id", "apprentice_pct"].forEach(function (f) {
        var v = get(row, f);
        if (v && !own(line.text, f)) line.text[f] = v;
      });
    });

    Object.keys(undecided).forEach(function (pt) {
      problems.push("Say what the pay type \"" + pt + "\" is: straight time, overtime, or leave out.");
    });
    if (count.otherJobs) notes.push("Left out " + plural(count.otherJobs, "row", "rows") + " for other jobs.");
    if (count.skippedTypes) notes.push("Left out " + plural(count.skippedTypes, "row", "rows") + " with a pay type you set to leave out.");
    if (count.outside) notes.push("Left out " + plural(count.outside, "row", "rows") + " dated outside the pay week, " + begin + " to " + end + ".");
    if (count.noDate) notes.push("Left out " + plural(count.noDate, "row", "rows") + " that had hours but no date. Those are subtotal rows in most reports. If they are real work, give them a date.");
    if (count.inherited) notes.push(plural(count.inherited, "row", "rows") + " had no worker name and " + (count.inherited === 1 ? "was" : "were") + " counted for the worker named above.");
    if (count.stacked) notes.push(plural(count.stacked, "row was", "rows were") + " added onto a worker and classification already seen higher up. That is right for split rows. If the file holds more than one week" + (has("week_ending") ? "" : ", pick the week ending column so the other weeks are left out") + ".");
    if (count.totalRows) notes.push("Left out " + plural(count.totalRows, "total row", "total rows") + ".");

    return { emps: emps, problems: problems, notes: notes, seen: seen, count: count, minDate: minDate, maxDate: maxDate, begin: begin, end: end };
  }

  function found(emp) {
    var from = { last_name: emp.last, first_name: emp.first, middle_initial: emp.mi, ssn: emp.ssn, employee_id: emp.id, gender: emp.gender, ethnicity: emp.ethnicity };
    NY_PERSON_FIELDS.forEach(function (f) { from[f] = emp.extra[f]; });
    return from;
  }

  function person(emp, setup) {
    var o = own(setup.people, emp.key) ? setup.people[emp.key] : {};
    var from = found(emp);
    var out = {};
    PERSON_FIELDS.concat(NY_PERSON_FIELDS).forEach(function (f) {
      out[f] = own(o, f) ? o[f].trim() : from[f]; // what the person typed wins, a typed blank included
    });
    return out;
  }

  // What the page shows before converting: who is in the file, which classifications, pay types and jobs.
  function inspect(table, setupIn) {
    var setup = normalizeSetup(setupIn);
    var g = gather(table, setup);
    var people = [];
    g.emps.forEach(function (emp) {
      var st = 0;
      var ot = 0;
      emp.lines.forEach(function (line) {
        line.days.forEach(function (d) {
          st += d.st;
          ot += d.ot;
        });
      });
      people.push({ key: emp.key, found: found(emp), shown: person(emp, setup), lines: emp.lines.size, st: fmtHours(st), ot: fmtHours(ot) });
    });
    // New York has no state codes: every classification gets a work category name and fringe rates.
    var directCodes = setup.target !== "ny" && !!setup.cols.craft_code && !!setup.cols.labor_class && own(table.index, setup.cols.craft_code) && own(table.index, setup.cols.labor_class);
    var classes = [];
    if (!directCodes) {
      var seenCls = {};
      g.emps.forEach(function (emp) {
        emp.lines.forEach(function (line) {
          if (!own(seenCls, line.cls)) {
            seenCls[line.cls] = true;
            classes.push(line.cls);
          }
        });
      });
    }
    return { target: setup.target, people: people, classes: classes, directCodes: directCodes, payTypes: g.seen.payTypes, jobs: g.seen.jobs, minDate: g.minDate, maxDate: g.maxDate, rowsKept: g.count.kept, notes: g.notes };
  }

  function gatherTotals(table, setup, byId, problems) {
    var t = setup.totals;
    var has = function (k) { return !!t.cols[k] && own(table.index, t.cols[k]); };
    var get = function (row, k) { return has(k) ? cellAt(row, table.index[t.cols[k]]) : ""; };
    var out = new Map();
    table.rows.forEach(function (row) {
      var n = row.n;
      var id = get(row, "employee_id");
      var last = get(row, "last_name");
      var first = get(row, "first_name");
      var full = get(row, "full_name");
      if (!last && !first && full) {
        var parts = splitName(full, t.nameOrder);
        last = parts.last;
        first = parts.first;
      }
      if (!id && !last && !first) return;
      if (TOTAL_ROW.test(full || last) || TOTAL_ROW.test(id)) return;
      if (byId && !id) return;
      var key = byId ? "id:" + id : nameKey(last, first);
      var label = byId ? id : last + (first ? ", " + first : "");
      if (out.has(key)) {
        problems.push("The pay totals file has more than one row for " + label + " (rows " + out.get(key).row + " and " + n + "). It needs one row per worker for this pay week.");
        return;
      }
      var rec = { row: n, money: {}, other: {} };
      var amount = function (header) {
        var raw = cellAt(row, table.index[header]);
        var m = parseMoney(raw);
        if (m === null) {
          problems.push("pay totals file, row " + n + ": column \"" + header + "\" should hold an amount, but has \"" + raw + "\"");
          return "";
        }
        return m;
      };
      MONEY_FIELDS.forEach(function (f) {
        if (!has(f)) return;
        var v = amount(t.cols[f]);
        if (v !== "") rec.money[f] = v;
      });
      t.otherDeductionCols.forEach(function (h) {
        if (!own(table.index, h)) return;
        var v = amount(h);
        if (v !== "") rec.other[h] = v;
      });
      out.set(key, rec);
    });
    return out;
  }

  // Exports often mask the SSN, like XXX-XX-1234. Keep the last four, which the XML carries as a partial SSN.
  function cleanSsn(v) {
    var s = String(v || "").replace(/[\s-]/g, "");
    var m = /^[xX*#]+([0-9]{4})$/.exec(s);
    return m ? m[1] : String(v || "").trim();
  }

  function csvCell(v) {
    v = v === undefined || v === null ? "" : String(v); // columns the mapper does not fill stay blank
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  // Returns { csv, notes, employees, lines, days }. Throws MapError with every problem found, in plain words.
  function build(hoursTable, totalsTable, setupIn) {
    var setup = normalizeSetup(setupIn);
    var g = gather(hoursTable, setup);
    var problems = g.problems.slice();
    var notes = g.notes.slice();
    var pay = setup.payroll;
    var c = setup.cols;
    var hasCol = function (k) { return !!c[k] && own(hoursTable.index, c[k]); };

    if (!pay.vendor_id) problems.push("Fill in your vendor ID with the state.");
    if (!pay.contract_id) problems.push("Fill in the contract ID.");
    if (!pay.payroll_number) problems.push("Fill in the payroll number.");
    if (!g.begin) problems.push(pay.period_begin ? "Cannot read the first day of the pay week: \"" + pay.period_begin + "\". Use a date like 2026-10-04 or 10/4/2026." : "Fill in the first day of the pay week.");
    if (!pay.fringe_type) problems.push("Pick the fringe type.");
    if (!hasCol("project_id") && !pay.project_id) problems.push("Fill in the project ID.");

    var totals = null;
    var byId = false;
    var tc = setup.totals.cols;
    if (totalsTable) {
      var tHas = function (k) { return !!tc[k] && own(totalsTable.index, tc[k]); };
      byId = hasCol("employee_id") && tHas("employee_id");
      if (!byId && !tHas("full_name") && !tHas("last_name")) {
        problems.push("In the pay totals file, pick the column that holds the worker's name" + (hasCol("employee_id") ? " or ID." : "."));
      } else {
        totals = gatherTotals(totalsTable, setup, byId, problems);
      }
    }
    var grossSource = hasCol("gross_pay") || (totalsTable && !!tc.gross_pay && own(totalsTable.index, tc.gross_pay));
    if (!grossSource) problems.push("No gross pay yet. Pick the gross pay column in this file, or add a second file that has each worker's pay totals for the week.");

    if (g.emps.size === 0 && g.problems.length === 0) {
      if (g.count.outside && g.minDate) problems.push("No rows fall inside the pay week, " + g.begin + " to " + g.end + ". The dates in the file run from " + g.minDate + " to " + g.maxDate + ".");
      else problems.push("No rows with a worker and hours were found in this file.");
    }

    var directCodes = hasCol("craft_code") && hasCol("labor_class");
    var needClass = {};
    var noOtRate = 0;
    var blankIdentity = 0;
    var manyLines = 0;
    var unmatched = [];
    var used = {};
    var out = [CANON.join(",")];
    var nLines = 0;
    var nDays = 0;
    var periodEnd = g.begin ? g.end : "";

    g.emps.forEach(function (emp) {
      var p = person(emp, setup);
      var label = (p.last_name || p.employee_id) + (p.first_name ? ", " + p.first_name : "");
      if (!p.last_name || !p.first_name) problems.push("The worker on row " + emp.row + " needs a first and a last name. Fix it in the workers table.");
      if (!p.gender || !p.ethnicity) blankIdentity++;

      var t = null;
      if (totals) {
        var keys = byId ? ["id:" + emp.id] : [nameKey(emp.last, emp.first), nameKey(p.last_name, p.first_name)];
        for (var k = 0; k < keys.length && !t; k++) {
          if (totals.has(keys[k])) {
            t = totals.get(keys[k]);
            used[keys[k]] = true;
          }
        }
        if (!t) unmatched.push(label);
      }
      if (t && emp.lines.size > 1) manyLines++;

      emp.lines.forEach(function (line) {
        nLines++;
        var craft = line.craft;
        var labor = line.labor;
        if (!directCodes) {
          var m = own(setup.classes, line.cls) ? setup.classes[line.cls] : {};
          craft = (m.craft_code || "").trim();
          labor = (m.labor_class || "").trim();
          if (!craft || !labor) needClass[line.cls] = true;
        }
        var money = {};
        MONEY_FIELDS.concat(["st_rate", "ot_rate"]).forEach(function (f) {
          if (own(line.money, f)) money[f] = line.money[f];
          else if (t && own(t.money, f)) money[f] = t.money[f];
        });
        var other = {};
        Object.keys(line.other).forEach(function (h) { other[h] = line.other[h]; });
        if (t) Object.keys(t.other).forEach(function (h) { if (!own(other, h)) other[h] = t.other[h]; });

        if (!own(money, "ot_rate") && own(money, "st_rate") && setup.otRule === "x1.5") {
          money.ot_rate = Math.floor((money.st_rate * 3 + 1) / 2);
        }
        if (!own(money, "ot_rate")) noOtRate++;
        if (setup.deductionsRule === "sum") {
          var sum = 0;
          TAX_FIELDS.forEach(function (f) { if (own(money, f)) sum += money[f]; });
          Object.keys(other).forEach(function (h) { sum += other[h]; });
          money.total_deductions = sum;
        }
        if (grossSource && !own(money, "gross_pay")) {
          if (!(totals && !t)) problems.push(label + ": no gross pay found for this worker.");
        } else if (setup.netRule === "calc" && own(money, "gross_pay")) {
          money.net_pay = money.gross_pay - (own(money, "total_deductions") ? money.total_deductions : 0);
        }
        var pairs = [];
        Object.keys(other).forEach(function (h) {
          if (other[h] !== 0) pairs.push(h.replace(/[:;]/g, " ").replace(/\s+/g, " ").trim() + ":" + fmt(other[h]));
        });

        var dates = Array.from(line.days.keys()).sort();
        dates.forEach(function (date) {
          var d = line.days.get(date);
          nDays++;
          var rec = {
            vendor_id: pay.vendor_id, contract_id: pay.contract_id, payroll_number: pay.payroll_number,
            period_begin: g.begin || "", period_end: periodEnd, fringe_type: pay.fringe_type,
            last_name: p.last_name, first_name: p.first_name, middle_initial: p.middle_initial, ssn: cleanSsn(p.ssn),
            employee_id: p.employee_id, gender: p.gender, ethnicity: p.ethnicity,
            craft_code: craft, labor_class: labor, project_id: line.project,
            apprentice: line.text.apprentice || "N",
            apprentice_id: line.text.apprentice_id || "", apprentice_pct: line.text.apprentice_pct || "",
            work_date: date, st_hours: fmtHours(d.st), ot_hours: fmtHours(d.ot),
            other_deductions: pairs.join(";")
          };
          MONEY_FIELDS.forEach(function (f) {
            rec[f] = own(money, f) ? fmt(money[f]) : "";
          });
          ["st_rate", "ot_rate"].forEach(function (f) {
            rec[f] = own(money, f) ? fmtRate(money[f]) : "";
          });
          out.push(CANON.map(function (col) { return csvCell(rec[col]); }).join(","));
        });
      });
    });

    Object.keys(needClass).forEach(function (cls) {
      problems.push(cls === "" ? "Fill in the craft code and labor class." : "Fill in the craft code and labor class for \"" + cls + "\".");
    });
    if (unmatched.length) problems.push("The pay totals file has no row for: " + unmatched.join("; ") + ". Names must match the hours file" + (byId ? "" : ", or pick an ID column in both files") + ".");
    if (noOtRate) notes.push(plural(noOtRate, "labor line has", "labor lines have") + " no overtime rate. Some states want one on every hourly line, even in a week with no overtime. Pick an overtime rate column, or choose straight rate times 1.5.");
    if (blankIdentity) notes.push(plural(blankIdentity, "worker has", "workers have") + " no gender or no ethnicity. Most states want both. Fill them in the workers table.");
    if (manyLines) notes.push(plural(manyLines, "worker has", "workers have") + " more than one labor line. The week's pay totals from the pay totals file are written on each line. Check that against how your state wants it.");
    if (totals) {
      var extra = 0;
      totals.forEach(function (rec, key) { if (!own(used, key)) extra++; });
      if (extra) notes.push(plural(extra, "worker", "workers") + " in the pay totals file had no hours in the hours file and were left out.");
    }

    if (problems.length) throw new MapError(problems);
    return { csv: out.join("\n") + "\n", notes: notes, employees: g.emps.size, lines: nLines, days: nDays };
  }

  // ---- New York State DOL bulk upload ----

  // Last 4 of an SSN from a full, masked or partial one. "" when blank, null when unreadable.
  function ssnLast4(v) {
    var s = cleanSsn(v).replace(/[\s-]/g, "");
    if (s === "") return "";
    if (/^[0-9]{4}$/.test(s) || /^[0-9]{9}$/.test(s)) return s.slice(-4);
    return null;
  }

  function cents2(v) {
    return v % 100 === 0; // a rate in ten-thousandths with at most two places
  }

  // Returns { csv, notes, employees, lines, days } in the layout docs/nydol.js converts.
  // Throws MapError with every problem found, in plain words.
  function buildNy(hoursTable, totalsTable, setupIn) {
    var setup = normalizeSetup(setupIn);
    setup.target = "ny";
    var g = gather(hoursTable, setup);
    var problems = g.problems.slice();
    var notes = g.notes.slice();
    var pay = setup.payroll;
    var c = setup.cols;
    var hasCol = function (k) { return !!c[k] && own(hoursTable.index, c[k]); };
    var said = {};
    var once = function (msg) {
      if (!own(said, msg)) {
        said[msg] = true;
        problems.push(msg);
      }
    };

    var prc = pay.prc_number;
    if (!prc) problems.push("Fill in the PRC number. It is the 10 character number on the prevailing rate schedule for this project.");
    else if (Array.from(prc).length !== 10) problems.push("The PRC number should be 10 characters, but \"" + prc + "\" has " + Array.from(prc).length + ".");
    if (!g.begin) problems.push(pay.period_begin ? "Cannot read the first day of the pay week: \"" + pay.period_begin + "\". Use a date like 2026-10-04 or 10/4/2026." : "Fill in the first day of the pay week.");

    var totals = null;
    var byId = false;
    var tc = setup.totals.cols;
    if (totalsTable) {
      var tHas = function (k) { return !!tc[k] && own(totalsTable.index, tc[k]); };
      byId = hasCol("employee_id") && tHas("employee_id");
      if (!byId && !tHas("full_name") && !tHas("last_name")) {
        problems.push("In the pay totals file, pick the column that holds the worker's name" + (hasCol("employee_id") ? " or ID." : "."));
      } else {
        totals = gatherTotals(totalsTable, setup, byId, problems);
      }
    }
    var grossSource = hasCol("gross_pay") || (totalsTable && !!tc.gross_pay && own(totalsTable.index, tc.gross_pay));
    if (!grossSource) problems.push("No gross pay yet. Pick the gross pay column in this file, or add a second file that has each worker's pay totals for the week.");

    if (g.emps.size === 0 && g.problems.length === 0) {
      if (g.count.outside && g.minDate) problems.push("No rows fall inside the pay week, " + g.begin + " to " + g.end + ". The dates in the file run from " + g.minDate + " to " + g.maxDate + ".");
      else problems.push("No rows with a worker and hours were found in this file.");
    }

    var needCat = {};
    var unmatched = [];
    var used = {};
    var both = 0;
    var onlyTotal = 0;
    var out = [NY_COLS.join(",")];
    var nLines = 0;
    var nDays = 0;
    var LABELS = [["federal_tax", "Federal Tax"], ["state_tax", "State Tax"], ["fica", "FICA"], ["medicare", "Medicare"]];

    g.emps.forEach(function (emp) {
      var p = person(emp, setup);
      var label = (p.last_name || p.employee_id) + (p.first_name ? ", " + p.first_name : "");
      if (!p.last_name || !p.first_name) problems.push("The worker on row " + emp.row + " needs a first and a last name. Fix it in the workers table.");

      var gaps = [];
      [["address1", "street address"], ["city", "city"], ["home_state", "state"], ["zip", "ZIP"]].forEach(function (f) {
        if (!p[f[0]]) gaps.push(f[1]);
      });
      if (gaps.length) problems.push(label + ": New York wants the worker's home address. Missing: " + gaps.join(", ") + ". Pick the address columns in step 2 or type it in the workers table.");

      var last4 = ssnLast4(p.ssn);
      if (last4 === null) problems.push(label + ": the SSN box should hold the last 4 digits, or a full or masked SSN, but has \"" + p.ssn + "\".");
      var dob = "";
      if (p.date_of_birth) {
        dob = parseDate(p.date_of_birth);
        if (!dob) problems.push(label + ": cannot read the date of birth \"" + p.date_of_birth + "\". Use a date like 1990-04-17 or 4/17/1990.");
      }
      if (last4 && dob) {
        both++;
        dob = ""; // the state takes one or the other, not both
      }
      if (last4 === "" && !p.date_of_birth) problems.push(label + ": New York wants the last 4 of the SSN or the date of birth. Fill in one of them in the workers table.");

      var t = null;
      if (totals) {
        var keys = byId ? ["id:" + emp.id] : [nameKey(emp.last, emp.first), nameKey(p.last_name, p.first_name)];
        for (var k = 0; k < keys.length && !t; k++) {
          if (totals.has(keys[k])) {
            t = totals.get(keys[k]);
            used[keys[k]] = true;
          }
        }
        if (!t) unmatched.push(label);
      }

      // The week's pay for the worker. New York carries one gross, one net and one deduction list per worker.
      var lines = Array.from(emp.lines.values());
      var weekly = function (values, total, what) {
        if (!values.length) return total;
        var allSame = values.every(function (v) { return v === values[0]; });
        if (allSame && !(setup.rowAmounts === "sum" && values.length > 1)) return values[0];
        if (setup.rowAmounts === "sum") return values.reduce(function (a, b) { return a + b; }, 0);
        once(label + ": " + what + " differs between classification lines (" + values.map(fmt).join(" and ") + "). New York takes one amount per worker for the week. Add a pay totals file, or tick the box that adds up the pay amounts in the hours file.");
        return values[0];
      };
      var money = {};
      MONEY_FIELDS.forEach(function (f) {
        var vals = [];
        lines.forEach(function (line) { if (own(line.money, f)) vals.push(line.money[f]); });
        var v = weekly(vals, t && own(t.money, f) ? t.money[f] : undefined, f === "gross_pay" ? "gross pay" : "\"" + (c[f] || f) + "\"");
        if (v !== undefined) money[f] = v;
      });
      var other = {};
      var otherHeads = [];
      lines.forEach(function (line) { Object.keys(line.other).forEach(function (h) { if (otherHeads.indexOf(h) < 0) otherHeads.push(h); }); });
      if (t) Object.keys(t.other).forEach(function (h) { if (otherHeads.indexOf(h) < 0) otherHeads.push(h); });
      otherHeads.forEach(function (h) {
        var vals = [];
        lines.forEach(function (line) { if (own(line.other, h)) vals.push(line.other[h]); });
        var v = weekly(vals, t && own(t.other, h) ? t.other[h] : undefined, "\"" + h + "\"");
        if (v !== undefined) other[h] = v;
      });
      if (setup.deductionsRule === "sum") {
        var sum = 0;
        TAX_FIELDS.forEach(function (f) { if (own(money, f)) sum += money[f]; });
        Object.keys(other).forEach(function (h) { sum += other[h]; });
        money.total_deductions = sum;
      }
      if (setup.netRule === "calc" && own(money, "gross_pay")) {
        money.net_pay = money.gross_pay - (own(money, "total_deductions") ? money.total_deductions : 0);
      }
      if (grossSource && !own(money, "gross_pay") && !(totals && !t)) problems.push(label + ": no gross pay found for this worker.");
      if (!own(money, "net_pay") && !(totals && !t)) once(label + ": no net pay found. New York wants net wages for each worker. Pick the net pay column, or tick the box that works it out.");

      var ded = [];
      LABELS.forEach(function (l) {
        if (own(money, l[0]) && money[l[0]] !== 0) ded.push([l[1], money[l[0]]]);
      });
      Object.keys(other).forEach(function (h) {
        if (other[h] !== 0) ded.push([h.replace(/[:;]/g, " ").replace(/\s+/g, " ").trim(), other[h]]);
      });
      if (!ded.length && own(money, "total_deductions") && money.total_deductions !== 0) {
        ded.push(["Total Deductions", money.total_deductions]);
        onlyTotal++;
      }
      ded.forEach(function (d) {
        if (d[1] < 0) problems.push(label + ": the deduction \"" + d[0] + "\" is below 0 (" + fmt(d[1]) + "). The state takes no negative deductions.");
      });

      var apprentice = "N";
      for (var a = 0; a < lines.length; a++) {
        if (lines[a].text.apprentice) {
          apprentice = lines[a].text.apprentice;
          break;
        }
      }

      // Labor lines become New York work categories. Two lines with the same category are one, with their days added.
      var cats = new Map();
      lines.forEach(function (line) {
        var m = own(setup.classes, line.cls) ? setup.classes[line.cls] : {};
        var cat = (m.work_category || line.cls || "").trim();
        if (!cat) {
          needCat[line.cls] = true;
          return;
        }
        var rates = {};
        ["st_rate", "ot_rate"].forEach(function (f) {
          if (own(line.money, f)) rates[f] = line.money[f];
          else if (t && own(t.money, f)) rates[f] = t.money[f];
        });
        if (!own(rates, "ot_rate") && own(rates, "st_rate") && setup.otRule === "x1.5") rates.ot_rate = Math.floor((rates.st_rate * 3 + 1) / 2);
        var where = label + ", " + cat;
        if (!own(rates, "st_rate")) once(where + ": no straight time rate. Pick the rate column in step 2.");
        if (!own(rates, "ot_rate")) once(where + ": no overtime rate. New York wants one on every work category, even in a week with no overtime. Pick an overtime rate column, or choose straight rate times 1.5.");
        ["st_rate", "ot_rate"].forEach(function (f) {
          if (own(rates, f) && !cents2(rates[f])) once(where + ": the " + (f === "st_rate" ? "straight time" : "overtime") + " rate " + fmtRate(rates[f]) + " has more than 2 decimal places. New York takes rates to the cent.");
        });
        var fr = {};
        NY_FRINGES.forEach(function (f) {
          var raw = (m[f] || "").trim();
          if (raw === "") return;
          var v = parseRate(raw);
          if (v === null || v === "" || v < 0 || !cents2(v)) once("The " + f + " fringe for \"" + (line.cls || "every row") + "\" should be an amount per hour with at most 2 decimals, like 12.50, but has \"" + raw + "\".");
          else if (v !== 0) fr[f] = fmtRate(v);
        });
        var expl = (m.other_explanation || "").trim();
        if (fr.other && !expl) once("The other fringe for \"" + (line.cls || "every row") + "\" needs a name, like Annuity. The state rejects it without one.");
        var cur = cats.get(cat);
        if (!cur) {
          cur = { rates: rates, fr: fr, expl: expl, days: new Map(), cls: line.cls };
          cats.set(cat, cur);
        } else {
          ["st_rate", "ot_rate"].forEach(function (f) {
            if (own(rates, f) && own(cur.rates, f) && rates[f] !== cur.rates[f]) once(where + ": two lines with this work category have different " + (f === "st_rate" ? "straight time" : "overtime") + " rates, " + fmtRate(cur.rates[f]) + " and " + fmtRate(rates[f]) + ". Give them different work category names.");
            if (own(rates, f) && !own(cur.rates, f)) cur.rates[f] = rates[f];
          });
          if (JSON.stringify(fr) !== JSON.stringify(cur.fr) || expl !== cur.expl) once(where + ": \"" + cur.cls + "\" and \"" + line.cls + "\" both become this work category but have different fringes. Make them match, or give them different work category names.");
        }
        line.days.forEach(function (d, date) {
          var x = cur.days.get(date);
          if (!x) {
            x = { st: 0, ot: 0 };
            cur.days.set(date, x);
          }
          x.st += d.st;
          x.ot += d.ot;
        });
      });

      cats.forEach(function (cur, cat) {
        nLines++;
        Array.from(cur.days.keys()).sort().forEach(function (date) {
          var d = cur.days.get(date);
          nDays++;
          var rec = {
            prc_number: prc, week_ending: g.begin ? g.end : "",
            last_name: p.last_name, first_name: p.first_name, middle_name: p.middle_initial,
            ssn_last4: last4 || "", date_of_birth: last4 ? "" : dob, apprentice: apprentice,
            address1: p.address1, address2: p.address2, city: p.city, state: p.home_state, zip: p.zip, country: "",
            gross_earnings: own(money, "gross_pay") ? fmt(money.gross_pay) : "",
            net_wages: own(money, "net_pay") ? fmt(money.net_pay) : "",
            deductions: ded.map(function (x) { return x[0] + ":" + fmt(x[1]); }).join(";"),
            work_category: cat,
            st_rate: own(cur.rates, "st_rate") ? fmtRate(cur.rates.st_rate) : "",
            ot_rate: own(cur.rates, "ot_rate") ? fmtRate(cur.rates.ot_rate) : "",
            other_explanation: cur.fr.other ? cur.expl : "",
            work_date: date, st_hours: fmtHours(d.st), ot_hours: fmtHours(d.ot)
          };
          NY_FRINGES.forEach(function (f) { rec[f] = cur.fr[f] || ""; });
          out.push(NY_COLS.map(function (col) { return csvCell(rec[col]); }).join(","));
        });
      });
    });

    Object.keys(needCat).forEach(function (cls) {
      problems.push(cls === "" ? "Fill in the work category, like Laborer - Building, the way the prevailing rate schedule names it." : "Fill in the work category for \"" + cls + "\".");
    });
    if (unmatched.length) problems.push("The pay totals file has no row for: " + unmatched.join("; ") + ". Names must match the hours file" + (byId ? "" : ", or pick an ID column in both files") + ".");
    if (both) notes.push(plural(both, "worker has", "workers have") + " both an SSN and a date of birth. The state takes one, so the file carries the last 4 of the SSN.");
    if (onlyTotal) notes.push(plural(onlyTotal, "worker has", "workers have") + " total deductions but no breakdown, so the file lists one deduction called Total Deductions. The state asks for each deduction by type. Pick the tax and other deduction columns if your file has them.");
    if (totals) {
      var extra = 0;
      totals.forEach(function (rec, key) { if (!own(used, key)) extra++; });
      if (extra) notes.push(plural(extra, "worker", "workers") + " in the pay totals file had no hours in the hours file and were left out.");
    }

    if (problems.length) throw new MapError(problems);
    return { csv: out.join("\n") + "\n", notes: notes, employees: g.emps.size, lines: nLines, days: nDays };
  }

  return {
    CANON: CANON,
    NY_COLS: NY_COLS,
    NY_PERSON_FIELDS: NY_PERSON_FIELDS,
    NY_FRINGES: NY_FRINGES,
    buildNy: buildNy,
    MapError: MapError,
    readTable: readTable,
    parseDate: parseDate,
    parseMoney: parseMoney,
    parseRate: parseRate,
    fmtRate: fmtRate,
    parseHours: parseHours,
    fmtHours: fmtHours,
    splitName: splitName,
    addDays: addDays,
    emptySetup: emptySetup,
    normalizeSetup: normalizeSetup,
    guess: guess,
    guessTotals: guessTotals,
    guessPayType: guessPayType,
    inspect: inspect,
    build: build,
    PERSON_FIELDS: PERSON_FIELDS
  };
});
