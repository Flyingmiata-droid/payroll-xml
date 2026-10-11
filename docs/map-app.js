/* The page around docs/mapper.js. Reads the files in this tab; sends nothing anywhere. MIT license. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var own = function (obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); };

  var state = {
    hours: null,   // { name, text, table }
    totals: null,  // { name, text, table }
    setup: prlmap.emptySetup(),
    setupFrom: "", // name of the loaded setup file, "" while the picks are the page's own guess
    info: null,    // last prlmap.inspect result
    current: null  // { xml, csv, name }
  };

  // ---- small helpers ----

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") e.textContent = attrs[k];
        else if (k === "class") e.className = attrs[k];
        else if (k === "hidden" || k === "checked" || k === "selected") e[k] = !!attrs[k];
        else if (k === "value") e.value = attrs[k];
        else e.setAttribute(k, attrs[k]);
      });
    }
    (kids || []).forEach(function (kid) {
      if (kid) e.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    });
    return e;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function save(text, name, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function baseName(name) {
    return name.replace(/\.[^.]*$/, "") || "payroll";
  }

  function headers() {
    return state.hours ? state.hours.table.headers : [];
  }

  // Anything changed: the last result no longer describes the page.
  function stale() {
    state.current = null;
    $("result").hidden = true;
  }

  // ---- controls ----

  function columnSelect(list, value, onPick) {
    var sel = el("select");
    sel.appendChild(el("option", { value: "", text: "(not in the file)" }));
    list.forEach(function (h) {
      sel.appendChild(el("option", { value: h, text: h }));
    });
    sel.value = list.indexOf(value) >= 0 ? value : "";
    sel.addEventListener("change", function () { onPick(sel.value); });
    return sel;
  }

  function field(label, control, hint) {
    return el("label", { class: "field" }, [el("span", { text: label }), control, hint ? el("small", { text: hint }) : null]);
  }

  // A column picker bound to one key of a cols object.
  function colField(target, key, label, hint, list, after) {
    return field(label, columnSelect(list, target[key] || "", function (v) {
      if (v) target[key] = v;
      else delete target[key];
      stale();
      if (after) after();
    }), hint);
  }

  function checkBox(label, checked, onFlip) {
    var box = el("input", { type: "checkbox", checked: checked });
    box.addEventListener("change", function () {
      onFlip(box.checked);
      stale();
    });
    return el("label", { class: "check" }, [box, el("span", { text: label })]);
  }

  function nameOrderField(target) {
    var sel = el("select");
    sel.appendChild(el("option", { value: "last_first", text: "Garcia, Luis A (last name first)" }));
    sel.appendChild(el("option", { value: "first_last", text: "Luis A Garcia (first name first)" }));
    sel.value = target.nameOrder;
    sel.addEventListener("change", function () {
      target.nameOrder = sel.value;
      stale();
      refresh();
    });
    return field("Full names read like", sel, "Only matters when the name is in one column.");
  }

  function otherChecks(box, list, picked) {
    clear(box);
    list.forEach(function (h) {
      box.appendChild(checkBox(h, picked.indexOf(h) >= 0, function (on) {
        var at = picked.indexOf(h);
        if (on && at < 0) picked.push(h);
        if (!on && at >= 0) picked.splice(at, 1);
      }));
    });
  }

  // ---- step 2: match the columns ----

  function renderPreview() {
    var t = state.hours.table;
    var table = el("table");
    var head = el("tr");
    t.headers.forEach(function (h) { head.appendChild(el("th", { scope: "col", text: h })); });
    table.appendChild(el("thead", null, [head]));
    var body = el("tbody");
    t.rows.slice(0, 5).forEach(function (row) {
      var tr = el("tr");
      t.headers.forEach(function (h, i) {
        var v = row.cells[i] === undefined ? "" : row.cells[i];
        tr.appendChild(el("td", { text: v.length > 40 ? v.slice(0, 40) + "..." : v }));
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    clear($("preview")).appendChild(table);
    $("header-row").value = t.headerRow;
  }

  function renderHoursGrid() {
    var s = state.setup;
    var list = headers();
    var grid = clear($("cols-hours"));
    var across = s.days === "across";
    var coded = s.payType === "code";
    var i;
    var dayField = function (arr, idx, label) {
      return field(label, columnSelect(list, arr[idx], function (v) {
        arr[idx] = v;
        stale();
        refresh();
      }), idx === 0 ? "A column named for a weekday or a date goes on that day. Any other goes in order from the first day of the pay week." : "");
    };
    if (!across) grid.appendChild(colField(s.cols, "work_date", "Date worked", "", list, refresh));
    if (across) {
      for (i = 0; i < 7; i++) grid.appendChild(dayField(s.dayCols.st, i, "Day " + (i + 1) + (coded ? " hours" : " straight time")));
      if (!coded) for (i = 0; i < 7; i++) grid.appendChild(dayField(s.dayCols.ot, i, "Day " + (i + 1) + " overtime"));
      grid.appendChild(colField(s.cols, "week_ending", "Week ending date", "Pick this if the file can hold more than one week. Rows for other weeks are left out.", list, refresh));
    } else if (coded) {
      grid.appendChild(colField(s.cols, "hours", "Hours", "", list, refresh));
    } else {
      grid.appendChild(colField(s.cols, "st_hours", "Straight time hours", "", list, refresh));
      grid.appendChild(colField(s.cols, "ot_hours", "Overtime hours", "", list, refresh));
    }
    if (coded) {
      grid.appendChild(colField(s.cols, "pay_type", "Pay type", "The column that says regular, overtime and so on.", list, function () { refresh(); }));
      grid.appendChild(colField(s.cols, "rate", "Pay rate", "Straight time rows give the straight rate. Overtime rows give the overtime rate.", list));
    } else {
      grid.appendChild(colField(s.cols, "st_rate", "Straight time rate", "", list));
      grid.appendChild(colField(s.cols, "ot_rate", "Overtime rate", "", list));
    }
    clear($("hours-rules")).appendChild(checkBox("When a worker has no overtime rate in the file, use the straight time rate times 1.5.", s.otRule === "x1.5", function (on) {
      s.otRule = on ? "x1.5" : "column";
    }));
  }

  function renderMatch() {
    var s = state.setup;
    var list = headers();
    renderPreview();
    Array.prototype.forEach.call(document.querySelectorAll('input[name="days"]'), function (r) { r.checked = r.value === s.days; });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="payType"]'), function (r) { r.checked = r.value === s.payType; });

    var worker = clear($("cols-worker"));
    worker.appendChild(colField(s.cols, "full_name", "Full name", "One column with the whole name.", list, refresh));
    worker.appendChild(nameOrderField(s));
    worker.appendChild(colField(s.cols, "last_name", "Last name", "If first and last are in their own columns.", list, refresh));
    worker.appendChild(colField(s.cols, "first_name", "First name", "", list, refresh));
    worker.appendChild(colField(s.cols, "middle_initial", "Middle initial", "", list, refresh));
    worker.appendChild(colField(s.cols, "employee_id", "Worker ID", "Your own number for the worker.", list, refresh));
    worker.appendChild(colField(s.cols, "ssn", "SSN or last 4", "A masked SSN like XXX-XX-1234 keeps its last 4.", list, refresh));
    worker.appendChild(colField(s.cols, "gender", "Gender", "", list, refresh));
    worker.appendChild(colField(s.cols, "ethnicity", "Ethnicity", "", list, refresh));

    var work = clear($("cols-work"));
    work.appendChild(colField(s.cols, "classification", "Work classification", "Laborer, Carpenter and so on, the way your payroll names them.", list, refresh));
    work.appendChild(colField(s.cols, "job", "Job", "Pick this when the file holds more than one job.", list, function () {
      s.jobs = [];
      refresh();
    }));
    work.appendChild(colField(s.cols, "project_id", "Project ID", "Only if the state's project ID is a column in the file.", list, function () {
      syncPayroll();
      refresh();
    }));
    work.appendChild(colField(s.cols, "craft_code", "Craft code", "Only if the file already holds the state's codes. Pick both.", list, refresh));
    work.appendChild(colField(s.cols, "labor_class", "Labor class", "", list, refresh));

    renderHoursGrid();

    $("pay-hint").textContent = state.totals
      ? "Pick these here if they are in the hours file. Anything not picked here comes from the pay totals file."
      : "The week's totals for each worker. If the hours file does not have them, add a pay totals file in step 1.";
    var pay = clear($("cols-pay"));
    [["gross_pay", "Gross pay"], ["fica", "FICA (Social Security)"], ["federal_tax", "Federal withholding"], ["state_tax", "State withholding"], ["medicare", "Medicare"], ["total_deductions", "Total deductions"], ["net_pay", "Net pay"]].forEach(function (f) {
      pay.appendChild(colField(s.cols, f[0], f[1], "", list));
    });
    var rules = clear($("pay-rules"));
    rules.appendChild(checkBox("Add up the taxes and other deductions to get total deductions.", s.deductionsRule === "sum", function (on) { s.deductionsRule = on ? "sum" : "column"; }));
    rules.appendChild(checkBox("Work out net pay as gross pay minus total deductions.", s.netRule === "calc", function (on) { s.netRule = on ? "calc" : "column"; }));
    rules.appendChild(checkBox("The pay amounts in the hours file are for each row. Add them up for the week.", s.rowAmounts === "sum", function (on) { s.rowAmounts = on ? "sum" : "repeat"; }));

    otherChecks($("other-hours"), list, s.otherDeductionCols);
    var extra = clear($("cols-extra"));
    [["project_gross", "Gross for this project only", "Leave out and the tool uses the rates times the hours."], ["lump_sum", "Lump sum or cash fringe", ""], ["apprentice", "Apprentice (Y or N)", ""], ["apprentice_id", "Apprentice ID", ""], ["apprentice_pct", "Apprentice wage percentage", ""]].forEach(function (f) {
      extra.appendChild(colField(s.cols, f[0], f[1], f[2], list));
    });

    $("totals-match").hidden = !state.totals;
    if (state.totals) {
      var tlist = state.totals.table.headers;
      var tg = clear($("cols-totals"));
      tg.appendChild(colField(s.totals.cols, "employee_id", "Worker ID", "", tlist));
      tg.appendChild(colField(s.totals.cols, "full_name", "Full name", "", tlist));
      tg.appendChild(nameOrderField(s.totals));
      tg.appendChild(colField(s.totals.cols, "last_name", "Last name", "", tlist));
      tg.appendChild(colField(s.totals.cols, "first_name", "First name", "", tlist));
      [["gross_pay", "Gross pay"], ["fica", "FICA (Social Security)"], ["federal_tax", "Federal withholding"], ["state_tax", "State withholding"], ["medicare", "Medicare"], ["total_deductions", "Total deductions"], ["net_pay", "Net pay"]].forEach(function (f) {
        tg.appendChild(colField(s.totals.cols, f[0], f[1], "", tlist));
      });
      otherChecks($("other-totals"), tlist, s.totals.otherDeductionCols);
    }
  }

  // ---- the parts that depend on what is in the file ----

  function renderPayTypes() {
    var s = state.setup;
    var box = clear($("paytypes"));
    if (s.payType !== "code" || !s.cols.pay_type) return;
    var values = Object.keys(state.info.payTypes);
    if (!values.length) return;
    box.appendChild(el("p", { class: "hint", text: "Say what each pay type in the file is. Leave out holiday, vacation, per diem and anything else that is not hours worked." }));
    var table = el("table");
    table.appendChild(el("thead", null, [el("tr", null, [el("th", { scope: "col", text: "Pay type in your file" }), el("th", { scope: "col", text: "Rows" }), el("th", { scope: "col", text: "This is" })])]));
    var body = el("tbody");
    values.forEach(function (v) {
      var sel = el("select", { "aria-label": "What " + (v || "blank") + " is" });
      [["", "Choose"], ["st", "Straight time"], ["ot", "Overtime"], ["skip", "Leave out"]].forEach(function (o) {
        sel.appendChild(el("option", { value: o[0], text: o[1] }));
      });
      sel.value = own(s.payTypes, v) ? s.payTypes[v] : "";
      sel.addEventListener("change", function () {
        if (sel.value) s.payTypes[v] = sel.value;
        else delete s.payTypes[v];
        stale();
        refresh({ payTypes: false });
      });
      body.appendChild(el("tr", null, [el("td", { text: v === "" ? "(blank)" : v }), el("td", { class: "num", text: String(state.info.payTypes[v]) }), el("td", null, [sel])]));
    });
    table.appendChild(body);
    box.appendChild(el("div", { class: "table-wrap" }, [table]));
  }

  function renderJobs() {
    var s = state.setup;
    var box = clear($("jobs"));
    if (!s.cols.job) return;
    var values = Object.keys(state.info.jobs);
    if (values.length < 2) return;
    box.appendChild(el("p", { class: "hint", text: "The file holds " + values.length + " jobs. Tick the ones on this contract. With none ticked, every row is used." }));
    var checks = el("div", { class: "checks" });
    values.forEach(function (v) {
      var input = el("input", { type: "checkbox", checked: s.jobs.indexOf(v) >= 0 });
      input.addEventListener("change", function () {
        var at = s.jobs.indexOf(v);
        if (input.checked && at < 0) s.jobs.push(v);
        if (!input.checked && at >= 0) s.jobs.splice(at, 1);
        stale();
        refresh({ jobs: false });
      });
      checks.appendChild(el("label", { class: "check" }, [input, el("span", { text: (v === "" ? "(blank)" : v) + ", " + plural(state.info.jobs[v], "row", "rows") })]));
    });
    box.appendChild(checks);
  }

  function renderWorkers() {
    var s = state.setup;
    var info = state.info;
    var wrap = clear($("workers"));
    if (!info.people.length) {
      wrap.appendChild(el("p", { class: "hint", text: "No workers found yet. Check the column picks in step 2." }));
    } else {
      var table = el("table");
      var head = el("tr");
      ["Last name", "First name", "MI", "SSN or last 4", "Your ID", "Gender", "Ethnicity", "Straight", "Overtime"].forEach(function (h) {
        head.appendChild(el("th", { scope: "col", text: h }));
      });
      table.appendChild(el("thead", null, [head]));
      var body = el("tbody");
      info.people.forEach(function (p) {
        var who = (p.shown.last_name || p.shown.employee_id) + (p.shown.first_name ? ", " + p.shown.first_name : "");
        var set = function (f, v) {
          v = v.trim();
          if (!own(s.people, p.key)) s.people[p.key] = {};
          if (v === p.found[f]) delete s.people[p.key][f];
          else s.people[p.key][f] = v;
          if (!Object.keys(s.people[p.key]).length) delete s.people[p.key];
          stale();
        };
        var text = function (f, label, narrow) {
          var input = el("input", { type: "text", value: p.shown[f], "aria-label": label + " for " + who, autocomplete: "off" });
          if (f === "middle_initial") input.maxLength = 1;
          input.addEventListener("input", function () { set(f, input.value); });
          return el("td", narrow ? { class: "narrow" } : null, [input]);
        };
        var gender = el("select", { "aria-label": "Gender for " + who });
        var known = { m: "Male", male: "Male", f: "Female", female: "Female" };
        var g = own(known, p.shown.gender.toLowerCase()) ? known[p.shown.gender.toLowerCase()] : p.shown.gender;
        ["", "Male", "Female"].concat(g && g !== "Male" && g !== "Female" ? [g] : []).forEach(function (o) {
          gender.appendChild(el("option", { value: o, text: o === "" ? "(blank)" : o }));
        });
        gender.value = g;
        gender.addEventListener("change", function () { set("gender", gender.value); });
        body.appendChild(el("tr", null, [
          text("last_name", "Last name"), text("first_name", "First name"), text("middle_initial", "Middle initial", true),
          text("ssn", "SSN or last 4"), text("employee_id", "Your ID"), el("td", null, [gender]), text("ethnicity", "Ethnicity"),
          el("td", { class: "num", text: p.st }), el("td", { class: "num", text: p.ot })
        ]));
      });
      table.appendChild(body);
      wrap.appendChild(table);
    }

    var cwrap = clear($("classes"));
    $("classes-wrap").hidden = info.directCodes || !info.classes.length;
    if (!$("classes-wrap").hidden) {
      var ctable = el("table");
      ctable.appendChild(el("thead", null, [el("tr", null, [el("th", { scope: "col", text: "Classification in your file" }), el("th", { scope: "col", text: "Craft code" }), el("th", { scope: "col", text: "Labor class" })])]));
      var cbody = el("tbody");
      info.classes.forEach(function (cls) {
        var cur = own(s.classes, cls) ? s.classes[cls] : {};
        var shown = cls === "" ? "(every row)" : cls;
        var input = function (f, label) {
          var box = el("input", { type: "text", value: cur[f] || "", "aria-label": label + " for " + shown, autocomplete: "off" });
          box.addEventListener("input", function () {
            if (!own(s.classes, cls)) s.classes[cls] = {};
            s.classes[cls][f] = box.value.trim();
            stale();
          });
          return el("td", null, [box]);
        };
        cbody.appendChild(el("tr", null, [el("td", { text: shown }), input("craft_code", "Craft code"), input("labor_class", "Labor class")]));
      });
      ctable.appendChild(cbody);
      cwrap.appendChild(ctable);
    }
  }

  function renderPeriod() {
    var s = state.setup;
    var begin = prlmap.parseDate(s.payroll.period_begin);
    var text = begin ? "Through " + prlmap.addDays(begin, 6) + "." : "The week is seven days.";
    if (state.info && state.info.minDate) text += " Dates in the file run from " + state.info.minDate + " to " + state.info.maxDate + ".";
    $("period-end").textContent = text;
  }

  // Re-read the file with the current picks and redraw what depends on it.
  function refresh(parts) {
    if (!state.hours) return;
    parts = parts || {};
    state.info = prlmap.inspect(state.hours.table, state.setup);
    if (parts.payTypes !== false) renderPayTypes();
    if (parts.jobs !== false) renderJobs();
    renderWorkers();
    renderPeriod();
  }

  // ---- step 3: the payroll facts ----

  var PAYROLL_KEYS = ["vendor_id", "contract_id", "payroll_number", "period_begin", "fringe_type", "project_id"];

  function syncPayroll() {
    var p = state.setup.payroll;
    if (prlmap.parseDate(p.period_begin)) p.period_begin = prlmap.parseDate(p.period_begin); // the date box wants 2026-10-04
    PAYROLL_KEYS.forEach(function (k) { $("p-" + k).value = p[k]; });
    $("p-project-wrap").hidden = !!state.setup.cols.project_id;
  }

  PAYROLL_KEYS.forEach(function (k) {
    var input = $("p-" + k);
    input.addEventListener(input.tagName === "SELECT" ? "change" : "input", function () {
      state.setup.payroll[k] = input.value.trim();
      stale();
      if (k === "period_begin") refresh();
    });
  });

  // ---- files ----

  function gotLine(node, file) {
    clear(node);
    node.hidden = !file;
    if (!file) return;
    node.appendChild(el("strong", { text: file.name }));
    node.appendChild(document.createTextNode(": " + plural(file.table.rows.length, "row", "rows") + ", " + plural(file.table.headers.length, "column", "columns") + "."));
  }

  function filesNote(lines) {
    var node = clear($("files-note"));
    node.hidden = !lines.length;
    lines.forEach(function (l, i) {
      if (i) node.appendChild(el("br"));
      node.appendChild(document.createTextNode(l));
    });
  }

  function readAs(text, headerRow) {
    try {
      return prlmap.readTable(text, headerRow);
    } catch (e) {
      if (!(e instanceof prlmap.MapError)) throw e;
      if (headerRow) throw e;
      return prlmap.readTable(text, 1); // no row looked like column names: start from row 1 and let the person move it
    }
  }

  function days(a, b) {
    return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  }

  // What to say after a setup meets a file: picks that point at columns the file does not have, and a pay week moved to fit.
  function fitSetup() {
    var s = state.setup;
    var notes = [];
    if (!state.hours) return notes;
    var list = headers();
    var missing = [];
    Object.keys(s.cols).forEach(function (k) {
      if (list.indexOf(s.cols[k]) < 0) missing.push(s.cols[k]);
    });
    s.dayCols.st.concat(s.dayCols.ot).forEach(function (h) {
      if (h && list.indexOf(h) < 0) missing.push(h);
    });
    if (missing.length) notes.push("The saved setup names " + plural(missing.length, "column", "columns") + " this file does not have: " + missing.join(", ") + ". Pick again in step 2.");
    var info = prlmap.inspect(state.hours.table, s);
    var begin = prlmap.parseDate(s.payroll.period_begin);
    if (begin && info.minDate && (info.minDate < begin || info.maxDate > prlmap.addDays(begin, 6))) {
      var moved = prlmap.addDays(begin, Math.floor(days(begin, info.minDate) / 7) * 7);
      if (info.maxDate <= prlmap.addDays(moved, 6)) {
        s.payroll.period_begin = moved;
        notes.push("The pay week moved to start " + moved + ", the same weekday as in the saved setup. The payroll number is still " + (s.payroll.payroll_number || "blank") + ". Change it for this week.");
      }
    } else if (begin && !info.minDate) {
      notes.push("The rows in this file carry no dates, so the page cannot tell which week it is. From the saved setup, the pay week still starts " + begin + " and the payroll number is still " + (s.payroll.payroll_number || "blank") + ". Change both in step 3 if this is a new week.");
    }
    return notes;
  }

  function showAll(notes) {
    stale();
    gotLine($("hours-got"), state.hours);
    gotLine($("totals-got"), state.totals);
    $("totals-clear").hidden = !state.totals;
    var lines = (notes || []).slice();
    if (state.setupFrom) lines.unshift("Setup loaded from " + state.setupFrom + ".");
    filesNote(lines);
    var ready = !!state.hours;
    ["match", "payroll", "people", "go"].forEach(function (id) { $(id).hidden = !ready; });
    if (!ready) return;
    renderMatch();
    syncPayroll();
    refresh();
  }

  function setHours(text, name, headerRow) {
    var table;
    try {
      table = readAs(text, headerRow || 0);
    } catch (e) {
      if (!(e instanceof prlmap.MapError)) throw e;
      if (!(headerRow && state.hours && state.hours.text === text)) state.hours = null; // a bad row number keeps the file as it was
      showAll([name + ": " + e.message]);
      return;
    }
    var first = !state.hours || state.hours.text !== text;
    state.hours = { name: name, text: text, table: table };
    var notes = [];
    if (state.setupFrom) {
      if (first) notes = fitSetup();
    } else {
      var guess = prlmap.guess(table);
      var old = state.setup;
      PAYROLL_KEYS.forEach(function (k) { if (old.payroll[k]) guess.payroll[k] = old.payroll[k]; });
      guess.people = old.people;
      guess.classes = old.classes;
      guess.totals = old.totals;
      state.setup = guess;
    }
    showAll(notes);
  }

  function setTotals(text, name) {
    var table;
    try {
      table = readAs(text, 0);
    } catch (e) {
      if (!(e instanceof prlmap.MapError)) throw e;
      showAll([name + ": " + e.message]);
      return;
    }
    state.totals = { name: name, text: text, table: table };
    if (!state.setupFrom || !Object.keys(state.setup.totals.cols).length) state.setup.totals = prlmap.guessTotals(table);
    showAll([]);
  }

  function setSetup(text, name) {
    var raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      showAll([name + " is not a setup file saved from this page."]);
      return;
    }
    if (!raw || typeof raw !== "object" || !raw.setup || raw.what !== "payroll-xml mapper setup") {
      showAll([name + " is not a setup file saved from this page."]);
      return;
    }
    state.setup = prlmap.normalizeSetup(raw.setup);
    state.setupFrom = name;
    showAll(fitSetup());
  }

  function takeFile(file, slot) {
    if (!file) return;
    var lower = file.name.toLowerCase();
    if (/\.json$/.test(lower)) slot = "setup";
    if (/\.(xlsx|xlsm|xls|ods|numbers)$/.test(lower)) {
      showAll([file.name + " is a spreadsheet workbook. This page reads CSV. In Excel, use File, Save As, CSV UTF-8, then pick that file."]);
      return;
    }
    if (/\.pdf$/.test(lower)) {
      showAll([file.name + " is a PDF. This page needs the export as a CSV file."]);
      return;
    }
    file.arrayBuffer().then(function (buf) {
      var text;
      try {
        text = prlxml.decodeCsvBytes(new Uint8Array(buf));
      } catch (e) {
        if (!(e instanceof prlxml.ConvertError)) throw e;
        showAll([file.name + ": " + e.message]);
        return;
      }
      if (slot === "setup") setSetup(text, file.name);
      else if (slot === "totals") setTotals(text, file.name);
      else setHours(text, file.name);
    });
  }

  function wireDrop(zone, slot) {
    zone.addEventListener("dragenter", function () { zone.classList.add("over"); });
    zone.addEventListener("dragover", function (e) {
      e.preventDefault();
      zone.classList.add("over");
    });
    zone.addEventListener("dragleave", function (e) {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove("over");
    });
    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      zone.classList.remove("over");
      if (!e.dataTransfer) return;
      Array.prototype.forEach.call(e.dataTransfer.files, function (f) { takeFile(f, slot); });
    });
  }

  function wirePicker(buttonId, inputId, slot) {
    var input = $(inputId);
    $(buttonId).addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () {
      takeFile(input.files[0], slot);
      input.value = "";
    });
  }

  // ---- step 5: convert ----

  function fill(listId, labelId, items) {
    var list = clear($(listId));
    items.forEach(function (t) { list.appendChild(el("li", { text: t })); });
    list.hidden = !items.length;
    if (labelId) $(labelId).hidden = !items.length;
  }

  function show(opts) {
    $("result").hidden = false;
    $("result-name").textContent = opts.name;
    var verdict = $("verdict");
    verdict.textContent = opts.verdict;
    verdict.className = "verdict " + (opts.ok ? "ok" : "bad");
    $("facts").textContent = opts.facts || "";
    $("facts").hidden = !opts.facts;
    fill("problems", null, opts.problems || []);
    fill("warnings", "warn-label", opts.warnings || []);
    fill("notes", "notes-label", opts.notes || []);
    $("download-row").hidden = !(opts.xml || opts.csv);
    $("download").hidden = !opts.xml;
    $("preview-wrap").hidden = !opts.xml;
    $("preview-wrap").open = false;
    $("xml-preview").textContent = opts.xml || "";
    $("not-checked").hidden = !opts.xml;
    state.current = opts.xml || opts.csv ? { xml: opts.xml || "", csv: opts.csv, name: opts.outName } : null;
    if (opts.xml) $("download").textContent = "Download " + opts.outName + ".xml";
    $("result").scrollIntoView({ block: "nearest" });
  }

  function convert() {
    var name = state.hours.name;
    var built;
    try {
      built = prlmap.build(state.hours.table, state.totals ? state.totals.table : null, state.setup);
    } catch (e) {
      if (!(e instanceof prlmap.MapError)) throw e;
      show({ name: name, ok: false, verdict: "Not ready to convert. " + plural(e.problems.length, "thing", "things") + " to sort out first.", problems: e.problems });
      return;
    }
    var xml;
    try {
      xml = prlxml.convertCsv(built.csv);
    } catch (e) {
      if (!(e instanceof prlxml.ConvertError)) throw e;
      show({ name: name, ok: false, verdict: "The matched rows did not convert.", problems: [e.message], facts: "Row numbers in this message count the matched rows. Download the matched CSV to see them.", notes: built.notes, csv: built.csv, outName: baseName(name) });
      return;
    }
    var res = prlxml.scanXml(xml);
    var facts = plural(built.employees, "employee", "employees") + ", " + plural(built.lines, "labor line", "labor lines") + ", " + plural(built.days, "day row", "day rows") + ". Pay period " + prlmap.parseDate(state.setup.payroll.period_begin) + " to " + prlmap.addDays(prlmap.parseDate(state.setup.payroll.period_begin), 6) + ".";
    show({
      name: name,
      ok: res.errors.length === 0,
      verdict: res.errors.length > 0
        ? "Converted, with " + plural(res.errors.length, "problem", "problems") + " to fix before you upload."
        : res.warnings.length > 0 ? "Converted. No problems, " + plural(res.warnings.length, "warning", "warnings") + " to look at."
        : "Converted. The rules check clean.",
      facts: facts,
      problems: res.errors,
      warnings: res.warnings,
      notes: built.notes,
      xml: xml,
      csv: built.csv,
      outName: baseName(name)
    });
  }

  function saveSetup() {
    var copy = prlmap.normalizeSetup(JSON.parse(JSON.stringify(state.setup)));
    var dropped = 0;
    if (!$("keep-ssn").checked) {
      // An SSN can sit in the SSN box, in any other box someone typed it into, or in the worker's key
      // when the SSN column was picked as the worker ID. None of those go into the file.
      var looksLikeSsn = /(^|[^0-9])[0-9]{3}[- ]?[0-9]{2}[- ]?[0-9]{4}([^0-9]|$)/;
      Object.keys(copy.people).forEach(function (k) {
        if (looksLikeSsn.test(k)) {
          delete copy.people[k];
          dropped++;
          return;
        }
        delete copy.people[k].ssn;
        Object.keys(copy.people[k]).forEach(function (f) {
          if (looksLikeSsn.test(copy.people[k][f])) delete copy.people[k][f];
        });
        if (!Object.keys(copy.people[k]).length) delete copy.people[k];
      });
    }
    $("save-note").textContent = dropped
      ? "Saved without what you typed for " + plural(dropped, "worker", "workers") + ", because the worker ID in this file looks like an SSN. Tick the box above to keep it."
      : "";
    $("save-note").hidden = !dropped;
    save(JSON.stringify({ what: "payroll-xml mapper setup", version: 1, setup: copy }, null, 2) + "\n", "payroll setup.json", "application/json");
  }

  // ---- wiring ----

  wirePicker("hours-choose", "hours-file", "hours");
  wirePicker("totals-choose", "totals-file", "totals");
  wirePicker("setup-choose", "setup-file", "setup");
  wireDrop($("hours-drop"), "hours");
  wireDrop($("totals-drop"), "totals");
  // Keep a stray drop from opening the file in the tab.
  ["dragover", "drop"].forEach(function (ev) {
    window.addEventListener(ev, function (e) { e.preventDefault(); });
  });

  $("totals-clear").addEventListener("click", function () {
    state.totals = null;
    showAll([]);
  });
  $("sample").addEventListener("click", function () {
    state.setupFrom = "";
    state.setup = prlmap.emptySetup();
    state.totals = null;
    state.hours = null;
    setHours(prlmapSamples.HOURS_CSV, "hours by pay type.csv");
    setTotals(prlmapSamples.TOTALS_CSV, "pay totals.csv");
    // The column picks above are the page's own guess. The rest is what a person would type.
    prlmapSamples.fill(state.setup);
    showAll(["Sample loaded. The people and numbers are made up. The column picks are the page's own guess from the column names. The payroll facts, the job, the worker details and the codes were typed in for you, the way you would for your own file."]);
  });
  $("header-row").addEventListener("change", function () {
    var n = parseInt($("header-row").value, 10);
    if (!state.hours || !(n >= 1)) return;
    setHours(state.hours.text, state.hours.name, n);
  });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="days"], input[name="payType"]'), function (r) {
    r.addEventListener("change", function () {
      if (!r.checked) return;
      state.setup[r.name] = r.value;
      stale();
      renderHoursGrid();
      refresh();
    });
  });
  $("convert").addEventListener("click", convert);
  $("save-setup").addEventListener("click", saveSetup);
  $("download").addEventListener("click", function () {
    if (state.current && state.current.xml) save(state.current.xml, state.current.name + ".xml", "application/xml");
  });
  $("download-csv").addEventListener("click", function () {
    if (state.current) save(state.current.csv, state.current.name + " matched.csv", "text/csv");
  });
})();
