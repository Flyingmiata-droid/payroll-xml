/* The page around docs/prlxml.js. Reads the file in this tab; sends nothing anywhere. MIT license. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var fileInput = $("file");
  var drop = $("drop");
  var current = null; // { xml, name }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function counter(xml) {
    var doc = new DOMParser().parseFromString(xml, "application/xml");
    var ns = prlxml.PRL_NS;
    return {
      count: function (tag) { return doc.getElementsByTagNameNS(ns, tag).length; },
      first: function (tag) {
        var e = doc.getElementsByTagNameNS(ns, tag)[0];
        return e ? e.textContent.trim() : "";
      }
    };
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

  function show(opts) {
    $("result").hidden = false;
    $("result-name").textContent = opts.name;
    var verdict = $("verdict");
    verdict.textContent = opts.verdict;
    verdict.className = "verdict " + (opts.ok ? "ok" : "bad");
    $("facts").textContent = opts.facts || "";
    $("facts").hidden = !opts.facts;
    var list = $("problems");
    list.textContent = "";
    (opts.problems || []).forEach(function (p) {
      var li = document.createElement("li");
      li.textContent = p;
      list.appendChild(li);
    });
    list.hidden = !(opts.problems && opts.problems.length);
    var warn = $("warnings");
    warn.textContent = "";
    (opts.warnings || []).forEach(function (w) {
      var li = document.createElement("li");
      li.textContent = w;
      warn.appendChild(li);
    });
    warn.hidden = !(opts.warnings && opts.warnings.length);
    $("warn-label").hidden = warn.hidden;
    $("download-row").hidden = !opts.xml;
    $("preview-wrap").hidden = !opts.xml;
    $("preview-wrap").open = false;
    $("preview").textContent = opts.xml || "";
    $("not-checked").hidden = !!opts.hideSchemaNote;
    current = opts.xml ? { xml: opts.xml, name: opts.outName } : null;
    if (opts.xml) $("download").textContent = "Download " + opts.outName;
    $("result").scrollIntoView({ block: "nearest" });
  }

  function summary(xml) {
    var c = counter(xml);
    var people = c.count("PayrollEmployee");
    var lines = c.count("PayrollEmployeeLabor");
    var days = c.count("PayrollEmployeeLaborHour");
    var begin = c.first("payrollBeginDate");
    var end = c.first("payrollEndDate");
    var text = plural(people, "employee", "employees") + ", " + plural(lines, "labor line", "labor lines") + ", " + plural(days, "day row", "day rows") + ".";
    if (begin && end) text += " Pay period " + begin + " to " + end + ".";
    return text;
  }

  function handleCsv(text, name) {
    var xml;
    try {
      xml = prlxml.convertCsv(text);
    } catch (e) {
      if (!(e instanceof prlxml.ConvertError)) throw e;
      show({
        name: name,
        ok: false,
        verdict: "This CSV did not convert.",
        problems: [e.message],
        facts: "Fix it in the spreadsheet and drop the file again. The column list is below.",
        hideSchemaNote: true
      });
      return;
    }
    var res = prlxml.scanXml(xml);
    var errs = res.errors;
    var warns = res.warnings;
    show({
      name: name,
      ok: errs.length === 0,
      verdict: errs.length > 0
        ? "Converted, with " + plural(errs.length, "problem", "problems") + " to fix before you upload."
        : warns.length > 0 ? "Converted. No problems, " + plural(warns.length, "warning", "warnings") + " to look at."
        : "Converted. The rules check clean.",
      facts: summary(xml),
      problems: errs,
      warnings: warns,
      xml: xml,
      outName: baseName(name) + ".xml"
    });
  }

  function handleXml(text, name) {
    var res = prlxml.scanXml(text);
    var errs = res.errors;
    var warns = res.warnings;
    var unreadable = errs.length === 1 && /^not well-formed XML/.test(errs[0]);
    var wellFormed = !(errs.length === 1 && /^not well-formed XML|^root element|^Payroll XML 1\.2 needs/.test(errs[0]));
    show({
      name: name,
      ok: errs.length === 0,
      verdict: unreadable ? "This file cannot be read as XML."
        : errs.length > 0 ? plural(errs.length, "problem", "problems") + " to fix before you upload."
        : warns.length > 0 ? "No problems, " + plural(warns.length, "warning", "warnings") + " to look at."
        : "The rules check clean.",
      hideSchemaNote: unreadable,
      facts: wellFormed ? summary(text) : "",
      problems: errs,
      warnings: warns
    });
  }

  function handleText(text, name) {
    var lower = name.toLowerCase();
    var looksXml = /\.xml$/.test(lower) || (!/\.csv$/.test(lower) && /^\s*</.test(text));
    if (looksXml) handleXml(text, name);
    else handleCsv(text, name);
  }

  function looksLikeXml(name, bytes) {
    var lower = name.toLowerCase();
    if (/\.xml$/.test(lower)) return true;
    if (/\.csv$/.test(lower)) return false;
    var head = "";
    for (var i = 0; i < Math.min(bytes.length, 64); i++) {
      if (bytes[i] !== 0 && bytes[i] < 128) head += String.fromCharCode(bytes[i]);
    }
    return /^\s*</.test(head);
  }

  function handleFile(file) {
    if (!file) return;
    var lower = file.name.toLowerCase();
    if (!/\.(csv|xml|txt)$/.test(lower)) {
      show({ name: file.name, ok: false, verdict: "This page reads .csv and .xml files.", facts: "In Excel, use File, Save As, CSV UTF-8.", hideSchemaNote: true });
      return;
    }
    file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      var text;
      if (looksLikeXml(file.name, bytes)) {
        try {
          text = prlxml.decodeXmlBytes(bytes);
        } catch (e) {
          show({ name: file.name, ok: false, verdict: "This file cannot be read as XML.", problems: ["not well-formed XML: " + e.message], hideSchemaNote: true });
          return;
        }
        handleXml(text, file.name);
      } else {
        try {
          text = prlxml.decodeCsvBytes(bytes);
        } catch (e) {
          if (!(e instanceof prlxml.ConvertError)) throw e;
          show({ name: file.name, ok: false, verdict: "This CSV did not convert.", problems: [e.message], hideSchemaNote: true });
          return;
        }
        handleCsv(text, file.name);
      }
    });
  }

  $("choose").addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    handleFile(fileInput.files[0]);
    fileInput.value = "";
  });
  $("sample").addEventListener("click", function () { handleText(prlxml.SAMPLE_CSV, "week1.csv"); });
  $("download").addEventListener("click", function () {
    if (current) save(current.xml, current.name, "application/xml");
  });
  $("get-template").addEventListener("click", function () { save(prlxml.TEMPLATE_CSV, "payroll template.csv", "text/csv"); });
  $("get-sample").addEventListener("click", function () { save(prlxml.SAMPLE_CSV, "week1.csv", "text/csv"); });

  // Keep a stray drop from opening the file in the tab.
  ["dragover", "drop"].forEach(function (ev) {
    window.addEventListener(ev, function (e) { e.preventDefault(); });
  });
  drop.addEventListener("dragenter", function () { drop.classList.add("over"); });
  drop.addEventListener("dragover", function (e) {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", function (e) {
    if (!drop.contains(e.relatedTarget)) drop.classList.remove("over");
  });
  drop.addEventListener("drop", function (e) {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer && e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
})();
