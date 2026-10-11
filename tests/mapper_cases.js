// Runs the column mapper (docs/mapper.js) under Node on the made-up exports in samples/exports.
// Each case goes export -> mapper -> docs/prlxml.js convert -> rule check.
// Exits 0 and prints the count when every check passes. tests/test_mapper.py runs it.
// The rule check needs @xmldom/xmldom on NODE_PATH; without it those checks are skipped and the count says so.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const prlxml = require(path.join(root, "docs", "prlxml.js"));
const prlmap = require(path.join(root, "docs", "mapper.js"));
const samples = require(path.join(root, "docs", "map-samples.js"));

let DOMParser = null;
try {
  DOMParser = require("@xmldom/xmldom").DOMParser;
} catch (e) {
  DOMParser = null;
}

let checks = 0;
let scans = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  checks++;
}
function eq(a, b, msg) {
  assert.strictEqual(a, b, msg);
  checks++;
}
function read(name) {
  return fs.readFileSync(path.join(root, "samples", "exports", name), "utf8");
}
function scan(xml) {
  if (!DOMParser) return null;
  scans++;
  return prlxml.scanXml(xml, DOMParser);
}
function problemsOf(fn) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof prlmap.MapError)) throw e;
    return e.problems;
  }
  return null;
}
function has(list, re) {
  return list !== null && list.some(function (p) { return re.test(p); });
}

const PAYROLL = { vendor_id: "V1001", contract_id: "20260001", payroll_number: "1", period_begin: "2026-10-04", fringe_type: "Cash", project_id: "9999-01-01" };
const CLASSES = { "Laborer Group 1": { craft_code: "100", labor_class: "101" }, "Carpenter": { craft_code: "200", labor_class: "201" } };
const WEEK1_XML = fs.readFileSync(path.join(root, "samples", "week1.xml"), "utf8");

// The column list must stay the one the converter reads.
eq(JSON.stringify(prlmap.CANON), JSON.stringify(prlxml.REQUIRED.concat(prlxml.OPTIONAL)), "CANON matches prlxml");

// The samples the page offers are the files in samples/exports.
eq(samples.HOURS_CSV, read("hours by pay type.csv"), "page sample hours file");
eq(samples.TOTALS_CSV, read("pay totals.csv"), "page sample totals file");

// ---- cells ----
eq(prlmap.parseDate("2026-10-05"), "2026-10-05");
eq(prlmap.parseDate("10/5/2026"), "2026-10-05");
eq(prlmap.parseDate("10/05/26"), "2026-10-05");
eq(prlmap.parseDate("10-05-2026 12:00:00 AM"), "2026-10-05");
eq(prlmap.parseDate("2026-10-05T00:00:00"), "2026-10-05");
eq(prlmap.parseDate("2/30/2026"), null);
eq(prlmap.parseDate("Monday"), null);
eq(prlmap.parseMoney("$1,239.75"), 123975);
eq(prlmap.parseMoney("(12.00)"), -1200);
eq(prlmap.parseMoney("12.00-"), -1200);
eq(prlmap.parseMoney("0.005"), 1);
eq(prlmap.parseMoney(""), "");
eq(prlmap.parseMoney("n/a"), null);
eq(prlmap.fmtHours(prlmap.parseHours("8")), "8.00");
eq(prlmap.fmtHours(prlmap.parseHours("7.75")), "7.75");
eq(prlmap.fmtHours(prlmap.parseHours("7:45")), "7.75");
eq(prlmap.fmtHours(prlmap.parseHours("7:20")), "7.33");
eq(prlmap.fmtHours(prlmap.parseHours("-1.5")), "-1.50");
eq(prlmap.fmtHours(prlmap.parseHours("8.005")), "8.01");
eq(prlmap.parseHours(""), 0);
eq(prlmap.parseHours("eight"), null);
// clock times add up before they are rounded: six 1:20 rows are a full 8.00
eq(prlmap.fmtHours(6 * prlmap.parseHours("1:20")), "8.00");
eq(prlmap.fmtHours(3 * prlmap.parseHours("2:40")), "8.00");
eq(JSON.stringify(prlmap.splitName("Garcia, Luis A.", "last_first")), JSON.stringify({ last: "Garcia", first: "Luis", mi: "A" }));
eq(JSON.stringify(prlmap.splitName("Garcia Luis A", "last_first")), JSON.stringify({ last: "Garcia", first: "Luis", mi: "A" }));
eq(JSON.stringify(prlmap.splitName("Luis A Garcia", "first_last")), JSON.stringify({ last: "Garcia", first: "Luis", mi: "A" }));
eq(JSON.stringify(prlmap.splitName("Tran Nguyen", "first_last")), JSON.stringify({ last: "Nguyen", first: "Tran", mi: "" }));
eq(JSON.stringify(prlmap.splitName("De La Cruz, Maria", "last_first")), JSON.stringify({ last: "De La Cruz", first: "Maria", mi: "" }));
eq(JSON.stringify(prlmap.splitName("Garcia, Luis A, Jr.", "last_first")), JSON.stringify({ last: "Garcia Jr", first: "Luis", mi: "A" }));
// rates keep the places they were typed with; the converter takes 3 on straight time and 4 on overtime
eq(prlmap.fmtRate(prlmap.parseRate("28.5")), "28.50");
eq(prlmap.fmtRate(prlmap.parseRate("$42.765")), "42.765");
eq(prlmap.fmtRate(prlmap.parseRate("42.7575")), "42.7575");
eq(prlmap.fmtRate(prlmap.parseRate("30")), "30.00");
eq(prlmap.guessPayType("REG"), "st");
eq(prlmap.guessPayType("1-Regular"), "st");
eq(prlmap.guessPayType("Regular Pay"), "st");
eq(prlmap.guessPayType("S"), "st");
eq(prlmap.guessPayType("OT"), "ot");
eq(prlmap.guessPayType("O.T."), "ot");
eq(prlmap.guessPayType("Overtime Pay"), "ot");
eq(prlmap.guessPayType("OT1"), "ot");
eq(prlmap.guessPayType("Laborer OT"), "ot");
eq(prlmap.guessPayType("VAC"), null);
eq(prlmap.guessPayType("Holiday"), null);

// ---- case 1: hours by pay type, days down the page, plus a pay totals file ----
// Must come out byte for byte as samples/week1.xml, the file the Python tool writes from samples/week1.csv.
(function () {
  const hours = prlmap.readTable(read("hours by pay type.csv"), 0);
  const totals = prlmap.readTable(read("pay totals.csv"), 0);
  const setup = prlmap.guess(hours);
  eq(hours.headerRow, 1);
  eq(setup.days, "down");
  eq(setup.payType, "code");
  eq(setup.cols.work_date, "Date");
  eq(setup.cols.full_name, "Employee");
  eq(setup.cols.job, "Job");
  eq(setup.cols.pay_type, "Pay ID");
  eq(setup.cols.hours, "Units");
  eq(setup.cols.rate, "Rate");
  eq(setup.nameOrder, "last_first");
  eq(setup.payTypes.REG, "st");
  eq(setup.payTypes.OT, "ot");
  // the pay week is never guessed
  eq(setup.payroll.period_begin, "");
  setup.totals = prlmap.guessTotals(totals);
  eq(setup.totals.cols.last_name, "Employee last name");
  eq(setup.totals.cols.first_name, "Employee first name");
  eq(setup.totals.cols.gross_pay, "Gross earnings");
  eq(setup.totals.cols.fica, "Social Security");
  eq(setup.totals.cols.federal_tax, "Federal Income Tax");
  eq(setup.totals.cols.state_tax, "State Income Tax");
  eq(setup.totals.cols.medicare, "Medicare");
  eq(setup.totals.cols.total_deductions, "Total deductions");
  eq(setup.totals.cols.net_pay, "Net pay");

  // what a person would add on the page
  setup.cols.classification = "Pay Class";
  setup.payroll = Object.assign({}, PAYROLL);
  setup.totals.otherDeductionCols = ["Union dues"];
  setup.otRule = "x1.5";

  // before the job is picked, the shop row clashes on rate and class
  let info = prlmap.inspect(hours, setup);
  eq(Object.keys(info.jobs).sort().join("|"), "9999-01-01|SHOP");
  eq(info.classes.slice().sort().join("|"), "Carpenter|Laborer Group 1|Shop");
  setup.jobs = ["9999-01-01"];
  info = prlmap.inspect(hours, setup);
  eq(info.classes.slice().sort().join("|"), "Carpenter|Laborer Group 1");
  eq(info.people.length, 2);
  eq(info.people[0].key, "name:garcia|luis");
  eq(info.people[0].shown.middle_initial, "A");
  eq(info.people[0].st, "40.00");
  eq(info.people[0].ot, "1.00");
  eq(info.people[1].st, "40.00");

  // missing codes are named, nothing is invented
  let p = problemsOf(function () { prlmap.build(hours, totals, setup); });
  ok(has(p, /craft code and labor class for "Laborer Group 1"/), "names the classification without codes");
  ok(has(p, /craft code and labor class for "Carpenter"/));
  eq(p.length, 2);

  setup.classes = CLASSES;
  setup.people = {
    "name:garcia|luis": { ssn: "1234", employee_id: "E01", gender: "M", ethnicity: "HISP" },
    "name:nguyen|tran": { ssn: "5678", employee_id: "E02", gender: "Female", ethnicity: "A-IN" }
  };
  // a setup survives being saved and read back
  const reread = prlmap.normalizeSetup(JSON.parse(JSON.stringify(setup)));
  const res = prlmap.build(hours, totals, reread);
  eq(res.employees, 2);
  eq(res.lines, 2);
  eq(res.days, 10);
  ok(has(res.notes, /Left out 1 row for other jobs/), "says the shop row was left out");
  ok(has(res.notes, /Left out 1 row dated outside the pay week/), "says next week's row was left out");
  ok(has(res.notes, /1 worker in the pay totals file had no hours/), "says the extra totals row was left out");
  const xml = prlxml.convertCsv(res.csv);
  eq(xml, WEEK1_XML, "mapped export converts to the same bytes as samples/week1.xml");
  const s = scan(xml);
  if (s) {
    eq(s.errors.length, 0, s.errors.join("\n"));
    eq(s.warnings.length, 0, s.warnings.join("\n"));
  }

  // without the 1.5 rule the missing overtime rate is called out
  const noRule = prlmap.normalizeSetup(JSON.parse(JSON.stringify(setup)));
  noRule.otRule = "column";
  const res2 = prlmap.build(hours, totals, noRule);
  ok(has(res2.notes, /1 labor line has no overtime rate\. Some states want one/));

  // a pay type nobody has sorted stops the run
  const vac = prlmap.readTable(read("hours by pay type.csv").replace("REG,4.00,34.10,afternoon", "VAC,4.00,34.10,afternoon"), 0);
  p = problemsOf(function () { prlmap.build(vac, totals, setup); });
  ok(has(p, /Say what the pay type "VAC" is/));
  const skipVac = prlmap.normalizeSetup(JSON.parse(JSON.stringify(setup)));
  skipVac.payTypes.VAC = "skip";
  const res3 = prlmap.build(vac, totals, skipVac);
  ok(has(res3.notes, /Left out 1 row with a pay type you set to leave out/));
  ok(/2026-10-09,4\.00,0\.00/.test(res3.csv), "vacation hours are not counted as work");

  // two straight rates on one classification
  const clash = prlmap.readTable(read("hours by pay type.csv").replace("Carpenter,REG,8.00,34.10,\n10/06", "Carpenter,REG,8.00,35.00,\n10/06"), 0);
  p = problemsOf(function () { prlmap.build(clash, totals, setup); });
  ok(has(p, /row 10: the straight time rate is 34\.10 here but 35\.00 on row 9, for Nguyen, Tran/), String(p));

  // a date the mapper cannot read
  const badDate = prlmap.readTable(read("hours by pay type.csv").replace("10/08/2026,\"Nguyen", "Thursday,\"Nguyen"), 0);
  p = problemsOf(function () { prlmap.build(badDate, totals, setup); });
  ok(has(p, /row 12: cannot read the date "Thursday" in column "Date"/), String(p));

  // hours that are not a number
  const badHours = prlmap.readTable(read("hours by pay type.csv").replace("REG,8.00,28.50,\n10/07", "REG,eight,28.50,\n10/07"), 0);
  p = problemsOf(function () { prlmap.build(badHours, totals, setup); });
  ok(has(p, /row 4: column "Units" should hold hours, but has "eight"/), String(p));

  // the wrong week
  const wrongWeek = prlmap.normalizeSetup(JSON.parse(JSON.stringify(setup)));
  wrongWeek.payroll.period_begin = "2026-09-06";
  p = problemsOf(function () { prlmap.build(hours, totals, wrongWeek); });
  ok(has(p, /No rows fall inside the pay week, 2026-09-06 to 2026-09-12\. The dates in the file run from 2026-10-05 to 2026-10-12/), String(p));

  // a worker missing from the totals file, and a doubled row in it
  const short = prlmap.readTable(read("pay totals.csv").replace(/^Nguyen.*\n/m, ""), 0);
  p = problemsOf(function () { prlmap.build(hours, short, setup); });
  ok(has(p, /The pay totals file has no row for: Nguyen, Tran/), String(p));
  const doubled = prlmap.readTable(read("pay totals.csv") + "Garcia,Luis,10.00,1,1,1,1,1,5,5\n", 0);
  p = problemsOf(function () { prlmap.build(hours, doubled, setup); });
  ok(has(p, /more than one row for Garcia, Luis \(rows 2 and 6\)/), String(p));

  // no totals at all
  p = problemsOf(function () { prlmap.build(hours, null, setup); });
  ok(has(p, /No gross pay yet/));

  // the payroll facts are asked for, one line each
  const bare = prlmap.normalizeSetup(JSON.parse(JSON.stringify(setup)));
  bare.payroll = { vendor_id: "", contract_id: "", payroll_number: "", period_begin: "", fringe_type: "", project_id: "" };
  p = problemsOf(function () { prlmap.build(hours, totals, bare); });
  ["vendor ID", "contract ID", "payroll number", "first day of the pay week", "fringe type", "project ID"].forEach(function (w) {
    ok(has(p, new RegExp(w)), "asks for the " + w);
  });
})();

// ---- the page's sample button: the guess plus the sample's typed values, nothing else ----
(function () {
  const hours = prlmap.readTable(samples.HOURS_CSV, 0);
  const totals = prlmap.readTable(samples.TOTALS_CSV, 0);
  const setup = prlmap.guess(hours);
  eq(setup.cols.classification, "Pay Class");
  setup.totals = prlmap.guessTotals(totals);
  samples.fill(setup);
  eq(prlxml.convertCsv(prlmap.build(hours, totals, setup).csv), WEEK1_XML, "the sample button gives samples/week1.xml");
  // a typed blank wins over the file
  setup.people["name:garcia|luis"].middle_initial = "";
  ok(/,Garcia,Luis,,1234,/.test(prlmap.build(hours, totals, setup).csv), "a blanked middle initial stays blank");
})();

// ---- case 2: one file, days across the page, title rows on top, a totals row at the bottom ----
(function () {
  const t = prlmap.readTable(read("week across.csv"), 0);
  eq(t.headerRow, 4, "skips the title rows");
  const setup = prlmap.guess(t);
  eq(setup.days, "across");
  eq(setup.payType, "columns");
  eq(setup.dayCols.st.join("|"), "Sun ST|Mon ST|Tue ST|Wed ST|Thu ST|Fri ST|Sat ST");
  eq(setup.dayCols.ot.join("|"), "Sun OT|Mon OT|Tue OT|Wed OT|Thu OT|Fri OT|Sat OT");
  eq(setup.cols.employee_id, "Emp No");
  eq(setup.cols.full_name, "Name");
  eq(setup.cols.ssn, "SSN");
  eq(setup.cols.gender, "Sex");
  eq(setup.cols.ethnicity, "Ethnicity");
  eq(setup.cols.classification, "Work Classification");
  eq(setup.cols.st_rate, "Rate of Pay");
  eq(setup.cols.ot_rate, "OT Rate");
  eq(setup.cols.gross_pay, "Gross Pay");
  eq(setup.cols.fica, "FICA");
  eq(setup.cols.federal_tax, "Federal Withholding");
  eq(setup.cols.state_tax, "State Withholding");
  eq(setup.cols.medicare, "Medicare");
  eq(setup.cols.total_deductions, "Total Deductions");
  eq(setup.cols.net_pay, "Net Pay");
  setup.otherDeductionCols = ["Union Dues"];
  setup.payroll = Object.assign({}, PAYROLL);
  setup.classes = CLASSES;
  const res = prlmap.build(t, null, setup);
  eq(res.employees, 2);
  eq(res.days, 14, "seven days for each worker, zeros included");
  ok(has(res.notes, /Left out 1 total row/));
  ok(/,Garcia,Luis,A,1234,E01,M,HISP,100,101,9999-01-01,N,28\.50,42\.75,2026-10-07,8\.00,1\.00,1239\.75,281\.21,958\.54,76\.86,148\.00,0\.00,17\.98,Union Dues:38\.37,/.test(res.csv), res.csv);
  ok(/,Nguyen,Tran,,5678,E02,F,A-IN,200,201,9999-01-01,N,34\.10,51\.15,2026-10-04,0\.00,0\.00,1364\.00,/.test(res.csv), "masked SSN keeps its last four");
  const xml = prlxml.convertCsv(res.csv);
  ok(xml.indexOf("<straightTimeHours>40.00</straightTimeHours>") > 0);
  ok(xml.indexOf("<PartialSsn>5678</PartialSsn>") > 0);
  const s = scan(xml);
  if (s) {
    eq(s.errors.length, 0, s.errors.join("\n"));
    eq(s.warnings.length, 0, s.warnings.join("\n"));
  }

  // adding up the deductions and working out net pay gives the same file
  const calc = prlmap.normalizeSetup(JSON.parse(JSON.stringify(setup)));
  delete calc.cols.total_deductions;
  delete calc.cols.net_pay;
  calc.deductionsRule = "sum";
  calc.netRule = "calc";
  eq(prlmap.build(t, null, calc).csv, res.csv, "summed deductions and worked out net pay match the file's own columns");

  // a typed header row number wins over the guess
  eq(prlmap.readTable(read("week across.csv"), 4).headers[0], "Emp No");
})();

// ---- case 3: stacked straight time and overtime rows, semicolons, clock style hours, names first-last ----
(function () {
  const t = prlmap.readTable(read("week stacked.csv"), 0);
  eq(t.delimiter, ";");
  const setup = prlmap.guess(t);
  eq(setup.days, "across");
  eq(setup.dayCols.st.join("|"), "Sun|Mon|Tue|Wed|Thu|Fri|Sat");
  eq(setup.nameOrder, "first_last");
  eq(setup.cols.classification, "Class");
  eq(setup.cols.gross_pay, "Gross");
  eq(setup.cols.net_pay, "Net");
  // what a person would pick
  setup.payType = "code";
  setup.cols.pay_type = "Type";
  setup.cols.rate = "Rate";
  setup.payTypes = { S: "st", O: "ot" };
  setup.cols.federal_tax = "Fed W/H";
  setup.cols.state_tax = "State W/H";
  setup.otherDeductionCols = ["Dues"];
  setup.deductionsRule = "sum";
  setup.payroll = Object.assign({}, PAYROLL);
  setup.classes = CLASSES;
  setup.people = {
    "name:garcia|luis": { ssn: "1234", gender: "Male", ethnicity: "HISP" },
    "name:nguyen|tran": { ssn: "5678", gender: "Female", ethnicity: "A-IN" }
  };
  const res = prlmap.build(t, null, setup);
  eq(res.employees, 2);
  eq(res.lines, 2, "the overtime row joins the line above it");
  ok(has(res.notes, /2 rows had no worker name and were counted for the worker named above/));
  ok(/,Garcia,Luis,A,1234,,Male,HISP,100,101,9999-01-01,N,28\.50,42\.75,2026-10-07,8\.00,1\.00,1239\.75,281\.21,958\.54,/.test(res.csv), res.csv);
  ok(/,Nguyen,Tran,,5678,,Female,A-IN,200,201,9999-01-01,N,34\.10,51\.15,2026-10-05,8\.00,0\.00,1364\.00,312\.44,1051\.56,/.test(res.csv), res.csv);
  const s = scan(prlxml.convertCsv(res.csv));
  if (s) {
    eq(s.errors.length, 0, s.errors.join("\n"));
    eq(s.warnings.length, 0, s.warnings.join("\n"));
  }
})();

// ---- breaks a fresh reviewer found on 2026-10-10, kept as tests ----
(function () {
  const base = function (t, extra) {
    const setup = prlmap.guess(t);
    setup.payroll = Object.assign({}, PAYROLL);
    setup.classes = { Laborer: { craft_code: "100", labor_class: "101" }, Operator: { craft_code: "300", labor_class: "301" } };
    return Object.assign(setup, extra || {});
  };

  // 1. two workers with one name and different SSNs are not merged
  let t = prlmap.readTable([
    "Date,Employee,SSN,Sex,Ethnicity,Class,Reg Hours,OT Hours,Rate,OT Rate,Gross,FICA,Federal,State Withholding,Medicare,Total Deductions,Net Pay",
    '10/05/2026,"Smith, John",111-11-1111,M,W,Laborer,8,0,30.00,45.00,240.00,14.88,20.00,0.00,3.48,38.36,201.64',
    '10/05/2026,"Smith, John",222-22-2222,M,B,Operator,8,0,40.00,60.00,320.00,19.84,30.00,0.00,4.64,54.48,265.52',
    ""
  ].join("\n"), 0);
  let p = problemsOf(function () { prlmap.build(t, null, base(t)); });
  ok(has(p, /Rows 2 and 3 look like two workers with the same name, Smith, John, but different SSNs.*Pick a worker ID column/), String(p));

  // 2. days across: a column named for a weekday or a date goes on that day, whatever the order
  const head = "Employee,Class,Mon,Tue,Wed,Thu,Fri,Sat,Sun,Rate,OT Rate,Gross,FICA,Federal,Medicare,Total Deductions,Net Pay";
  t = prlmap.readTable(head + '\n"Doe, Jane",Laborer,8,0,0,0,0,0,2,30.00,45.00,300.00,18.60,20.00,4.35,42.95,257.05\n', 0);
  let s = base(t);
  eq(s.dayCols.st.join("|"), "Mon|Tue|Wed|Thu|Fri|Sat|Sun");
  let csv = prlmap.build(t, null, s).csv;
  ok(/,2026-10-05,8\.00,0\.00,/.test(csv), "Monday's hours land on Monday 10/05, not on the first day of the week");
  ok(/,2026-10-04,2\.00,0\.00,/.test(csv), "Sunday's hours land on Sunday 10/04");
  t = prlmap.readTable("Employee,Class,10/05/2026,10/06/2026,10/07/2026,10/08/2026,10/09/2026,10/10/2026,10/11/2026,Rate,OT Rate,Gross,Total Deductions,Net Pay\n" + '"Doe, Jane",Laborer,8,0,0,0,0,0,2,30.00,45.00,300.00,42.95,257.05\n', 0);
  s = base(t);
  eq(s.days, "across");
  p = problemsOf(function () { prlmap.build(t, null, s); });
  ok(has(p, /The day column "10\/11\/2026" is outside the pay week, 2026-10-04 to 2026-10-10/), String(p));
  s.payroll.period_begin = "2026-10-05";
  ok(/,2026-10-11,2\.00,0\.00,/.test(prlmap.build(t, null, s).csv), "date headers place the hours");
  // two columns on one day
  t = prlmap.readTable("Employee,Class,Mon,Monday,Wed,Thu,Fri,Sat,Sun,Rate,Gross,Net Pay\n" + '"Doe, Jane",Laborer,8,0,0,0,0,0,0,30.00,240.00,200.00\n', 0);
  p = problemsOf(function () { prlmap.build(t, null, base(t)); });
  ok(has(p, /Two day columns land on the same day, 2026-10-05: "Mon" and "Monday"/), String(p));
  // two weeks in one file: the week ending column keeps them apart, and without it the page says rows were stacked
  const two = "Employee,Class,Week Ending,Sun,Mon,Tue,Wed,Thu,Fri,Sat,Rate,OT Rate,Gross,Total Deductions,Net Pay\n" +
    '"Doe, Jane",Laborer,10/10/2026,0,8,8,8,8,8,0,30.00,45.00,1200.00,200.00,1000.00\n' +
    '"Doe, Jane",Laborer,10/17/2026,0,8,8,8,8,8,0,30.00,45.00,1200.00,200.00,1000.00\n';
  t = prlmap.readTable(two, 0);
  s = base(t);
  eq(s.cols.week_ending, "Week Ending");
  let res = prlmap.build(t, null, s);
  ok(has(res.notes, /Left out 1 row dated outside the pay week/), String(res.notes));
  ok(/,2026-10-05,8\.00,0\.00,/.test(res.csv) && !/16\.00/.test(res.csv), "one week only");
  eq(prlmap.inspect(t, s).minDate, "2026-10-04");
  eq(prlmap.inspect(t, s).maxDate, "2026-10-17");
  delete s.cols.week_ending;
  res = prlmap.build(t, null, s);
  ok(has(res.notes, /1 row was added onto a worker and classification already seen higher up.*pick the week ending column/), String(res.notes));

  // 4. clock style rows add up before rounding
  const rows = ["Date,Emp No,Employee,Class,Hours,Rate,Gross,Net Pay"];
  for (let i = 0; i < 6; i++) rows.push('10/05/2026,E1,"Doe, Jane",Laborer,1:20,30.00,240.00,200.00');
  t = prlmap.readTable(rows.join("\n") + "\n", 0);
  s = base(t);
  eq(s.cols.st_hours, "Hours");
  ok(/,2026-10-05,8\.00,0\.00,/.test(prlmap.build(t, null, s).csv), "six rows of 1:20 are 8.00 hours");

  // a rate with three places is not rounded to cents, and the 1.5 rule keeps four
  t = prlmap.readTable('Date,Employee,Class,Reg Hours,OT Hours,Rate,Gross,Net Pay\n10/05/2026,"Doe, Jane",Laborer,8,1,28.505,270.80,200.00\n', 0);
  s = base(t, { otRule: "x1.5" });
  csv = prlmap.build(t, null, s).csv;
  ok(/,N,28\.505,42\.7575,2026-10-05,8\.00,1\.00,/.test(csv), csv);
  ok(prlxml.convertCsv(csv).indexOf("<txl:amount>28.505</txl:amount>") > 0, "the converter writes the rate as typed");

  // 5. a continuation row with a blank job stays with the row above it
  t = prlmap.readTable([
    "Employee;Job;Class;Pay Type;Sun;Mon;Tue;Wed;Thu;Fri;Sat;Rate;Gross;Total Deductions;Net",
    "Jane Doe;9999;Laborer;S;;8:00;8:00;8:00;8:00;8:00;;30.00;1245.00;195.24;1049.76",
    ";;;O;;;;1:00;;;;45.00;;;",
    "Jane Doe;SHOP;Laborer;S;;;;;;;2:00;30.00;1245.00;195.24;1049.76",
    ";;;O;;;;;;;1:00;45.00;;;",
    ""
  ].join("\n"), 0);
  s = base(t, { jobs: ["9999"] });
  eq(s.payType, "code");
  s.payTypes = { S: "st", O: "ot" };
  res = prlmap.build(t, null, s);
  ok(/,2026-10-07,8\.00,1\.00,/.test(res.csv), "the overtime row under the contract job is kept");
  ok(has(res.notes, /Left out 2 rows for other jobs/), String(res.notes));
  ok(!/,2026-10-10,[0-9.]+,1\.00,/.test(res.csv), "the overtime row under the shop job is left out with it");
})();

// ---- reading odd files ----
(function () {
  const p = problemsOf(function () { prlmap.readTable("", 0); });
  ok(has(p, /Cannot find the row of column names/));
  const t = prlmap.readTable("\ufeffName\tDate\tHours\tHours\t\r\nGarcia, Luis\t10/5/2026\t8\t1\tx\r\n\r\n", 0);
  eq(t.delimiter, "\t");
  eq(t.headers.join("|"), "Name|Date|Hours|Hours (2)|Column E");
  eq(t.rows.length, 1);
  eq(t.rows[0].n, 2);
  // a setup file from somewhere else cannot plant odd values
  const s = prlmap.normalizeSetup({ days: "sideways", payTypes: { REG: "st", X: "maybe" }, cols: { hours: 5, bad: {} }, payroll: { vendor_id: " V1 ", extra: "x" }, people: "nope", dayCols: { st: ["a"] } });
  eq(s.days, "down");
  eq(JSON.stringify(s.payTypes), JSON.stringify({ REG: "st" }));
  eq(JSON.stringify(s.cols), JSON.stringify({ hours: "5" }));
  eq(s.payroll.vendor_id, "V1");
  eq(Object.keys(s.payroll).length, 6);
  eq(JSON.stringify(s.people), "{}");
  eq(s.dayCols.st.length, 7);
})();

console.log(checks + " checks passed" + (DOMParser ? ", " + scans + " files rule checked" : ", rule check skipped (no @xmldom/xmldom)"));
