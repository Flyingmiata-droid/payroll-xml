// Runs docs/nydol.js under Node on every case file in a folder and prints one JSON object:
// {name: {xml} | {error} | {errors, warnings}}. tests/test_nydol.py compares that with the
// Python tool. Needs @xmldom/xmldom (0.8 or 0.9) on NODE_PATH.
"use strict";
const fs = require("fs");
const path = require("path");
const { DOMParser } = require("@xmldom/xmldom");
const prlxml = require(path.join(__dirname, "..", "docs", "prlxml.js"));
const nydol = require(path.join(__dirname, "..", "docs", "nydol.js"));

const dir = process.argv[2];
const out = {};
for (const name of fs.readdirSync(dir).sort()) {
  const bytes = fs.readFileSync(path.join(dir, name));
  if (name.endsWith(".csv")) {
    try {
      out[name] = { xml: nydol.convertCsv(prlxml.decodeCsvBytes(bytes)) };
    } catch (e) {
      if (!(e instanceof nydol.ConvertError)) throw e;
      out[name] = { error: e.message };
    }
  } else if (name.endsWith(".xml")) {
    out[name] = nydol.checkXml(prlxml.decodeXmlBytes(bytes), DOMParser);
  }
}
out["__sample__"] = nydol.SAMPLE_CSV;
out["__template__"] = nydol.TEMPLATE_CSV;
process.stdout.write(JSON.stringify(out));
