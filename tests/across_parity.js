// Runs the browser cross-file check (docs/prlxml.js and docs/nydol.js acrossFiles) under Node
// on every .xml file in a folder, in name order, and prints
// {prl: {headers, warnings}, ny: {headers, warnings}}. tests/test_across.py compares that with the
// Python tool. Needs @xmldom/xmldom on NODE_PATH.
"use strict";
const fs = require("fs");
const path = require("path");
const { DOMParser } = require("@xmldom/xmldom");
const prlxml = require(path.join(__dirname, "..", "docs", "prlxml.js"));
const nydol = require(path.join(__dirname, "..", "docs", "nydol.js"));

const dir = process.argv[2];
const names = fs.readdirSync(dir).filter((n) => n.endsWith(".xml")).sort();
const out = {};
for (const [key, lib, decode] of [["prl", prlxml, true], ["ny", nydol, false]]) {
  const items = names.map((name) => {
    const bytes = fs.readFileSync(path.join(dir, name));
    let text;
    try {
      text = decode ? prlxml.decodeXmlBytes(bytes) : bytes.toString("utf8");
    } catch (e) {
      return { name, header: null };
    }
    return { name, header: lib.headerOf(text, DOMParser) };
  });
  const headers = {};
  items.forEach((it) => { headers[it.name] = it.header; });
  out[key] = { headers, warnings: lib.acrossFiles(items) };
}
process.stdout.write(JSON.stringify(out));
