// Runs the browser code (docs/prlxml.js) under Node on every case file in a folder
// and prints one JSON object: {name: {xml} | {error} | {errors, warnings}}.
// tests/test_web.py compares that with the Python tool. Needs @xmldom/xmldom on NODE_PATH.
"use strict";
const fs = require("fs");
const path = require("path");
const { DOMParser } = require("@xmldom/xmldom");
const prlxml = require(path.join(__dirname, "..", "docs", "prlxml.js"));

const dir = process.argv[2];
const out = {};
for (const name of fs.readdirSync(dir).sort()) {
  const bytes = fs.readFileSync(path.join(dir, name));
  if (name.endsWith(".csv")) {
    try {
      out[name] = { xml: prlxml.convertCsv(prlxml.decodeCsvBytes(bytes)) };
    } catch (e) {
      if (!(e instanceof prlxml.ConvertError)) throw e;
      out[name] = { error: e.message };
    }
  } else if (name.endsWith(".xml")) {
    let text;
    try {
      text = prlxml.decodeXmlBytes(bytes);
    } catch (e) {
      out[name] = { errors: ["not well-formed XML: " + e.message], warnings: [] };
      continue;
    }
    out[name] = prlxml.scanXml(text, DOMParser);
  }
}
process.stdout.write(JSON.stringify(out));
