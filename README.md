Open source converter and checker for certified payroll XML, the Payroll XML 1.2 format (TransXML based) that state DOT systems import for Davis-Bacon highway jobs.

Today a small contractor on a state highway job fills a state spreadsheet by hand every week, uploads it to a web converter, imports the XML, reads the error log, fixes the spreadsheet, and does it all again. This tool does the convert step and the error step on your own machine, before the upload.

Status: version 0, built 2026-10-10. `samples/week1.xml`, written by this tool, passed the official AASHTOWare Project online Payroll XML validator on 2026-10-10 ("The source document is valid Payroll XML"). It has not yet been run through a state import. Treat it as a prototype until it has.

## What it does

`convert` turns a flat CSV (one row per employee, per labor class, per day) into a Payroll XML file. It fills blank hours with 0.00 and strips dashes from SSNs on the way. Rates, weekly totals, gender and the other values the XML holds once per worker must match on every row for that worker; if one differs, convert stops and names the row instead of keeping the first value.

`check` validates a Payroll XML file against the published schema, then runs the plain-English rules state import pages publish: a payroll number of 1 or more, a seven-day period, dates inside the period, hours filled with 0.00, daily hours that add up to the straight time, overtime and total hours, SSN with no dashes, a one-character middle initial, gross minus deductions equal to net pay, and the field length limits. It works on Payroll XML from any tool, including ones your payroll software exports.

## Quick start

    python -m prlxml.fetch_schemas
    python -m prlxml.convert samples/week1.csv -o week1.xml
    python -m prlxml.check week1.xml

Needs Python 3.10 or newer and `lxml`.

## In your browser

`docs/index.html` is the same converter and the same rule checks as one web page. Open it, drop a CSV or a Payroll XML file, and download the XML. Everything runs in the browser tab. The page sends nothing anywhere, and its content security policy blocks every outside request, so SSNs stay on the machine.

The page does not run the schema check, because the AASHTO schema files are not redistributed here. For that, use the Python tool or the official online validator at https://xml.aashtowareproject.org/resourcekit/validator.html.

The page gives the same answers as the Python tool. `tests/test_web.py` runs both on a set of CSV and XML cases and compares them: converted XML byte for byte, rule and convert messages word for word. A file the XML parser cannot read is refused by both, in the parser's own words, so that wording differs. The test needs Node and `@xmldom/xmldom` and skips without them.

To use it from a copy of this repo, open `docs/index.html` in a browser. No server needed.

## CSV layout

One row per employee, per labor class, per day worked. Header row required. See `samples/week1.csv`.

Header columns (same on every row): `vendor_id, contract_id, payroll_number, period_begin, period_end, fringe_type`

Employee columns: `last_name, first_name, middle_initial, ssn, employee_id, gender, ethnicity`

Labor columns: `craft_code, labor_class, project_id, apprentice, st_rate, ot_rate`

Day columns: `work_date, st_hours, ot_hours`

Totals columns (same on every row for one employee and labor class): `gross_pay, total_deductions, net_pay, fica, federal_tax, state_tax, medicare, other_deductions`

`other_deductions` is `description:amount` pairs separated by `;`. Leave it empty when there are none.

Rows where every cell is blank are skipped. Spreadsheet exports often end with a few rows of bare commas.

Excel habits it handles: dates saved as 10/4/2026 are read as 2026-10-04, a plain "CSV" save (Windows-1252) is read as well as "CSV UTF-8", and float leftovers like -1.1E-13 come out as 0.00. A file that mixes two text encodings is refused, so accented names never come out garbled. Excel can also turn a project number that looks like a date into a date; format that column as Text before you save.

`gender` takes Male or Female (M and F are mapped). Code values for `ethnicity`, `fringe_type`, `craft_code` and `labor_class` come from your state's own list. The tool passes them through. It does not invent them. The sample uses Wisconsin's codes (craft 100 Laborers, labor class 101 Laborer Group 1, ethnicity HISP and A-IN) as they appear on the WisDOT spreadsheet template v3.

## Where this fits

Today's road on a state highway job: your payroll system, then hand entry into the state's Excel template (Wisconsin's is one form per employee, fifty blocks), then the web converter, then the import, then the error log. This tool replaces the middle. Export a flat CSV from payroll, convert, check, upload.

States that import this format through their AASHTOWare Project Civil Rights and Labor module include Wisconsin, Ohio, Alaska, Louisiana, Oklahoma, Connecticut and West Virginia (each state publishes its own contractor payroll page and its own code lists). If your state is not listed and imports Payroll XML, open an issue with a link to its page.

## Schema

The schema files are published by AASHTO at xml.aashtowareproject.org (Payroll XML Resource Kit). They are not redistributed here. `fetch_schemas` downloads them into `schemas/`.

## Why open source

Certified payroll is a public obligation on public money. The format is public. The tool to meet it should be too.

## License

MIT. See LICENSE. The web page uses the Overpass typeface under the SIL Open Font License (docs/fonts/OFL.txt).
