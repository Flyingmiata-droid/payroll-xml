Open source converter and checker for certified payroll XML, the Payroll XML 1.2 format (TransXML based) that state DOT systems import for Davis-Bacon highway jobs.

Today a small contractor on a state highway job fills a state spreadsheet by hand every week, uploads it to a web converter, imports the XML, reads the error log, fixes the spreadsheet, and does it all again. This tool does the convert step and the error step on your own machine, before the upload.

Status: version 0, built 2026-10-10. `samples/week1.xml`, written by this tool, passed the official AASHTOWare Project online Payroll XML validator on 2026-10-10 ("The source document is valid Payroll XML"). It has not yet been run through a state import. Treat it as a prototype until it has.

## What it does

`convert` turns a flat CSV (one row per employee, per labor class, per day) into a Payroll XML file. It fills blank hours with 0.00 and strips dashes from SSNs on the way.

`check` validates a Payroll XML file against the published schema, then runs the plain-English rules state import pages publish: payroll numbers in order, a seven-day period, dates inside the period, hours filled with 0.00, SSN with no dashes, a one-letter middle initial, and gross minus deductions equal to net pay. It works on Payroll XML from any tool, including ones your payroll software exports.

## Quick start

    python -m prlxml.fetch_schemas
    python -m prlxml.convert samples/week1.csv -o week1.xml
    python -m prlxml.check week1.xml

Needs Python 3.10 or newer and `lxml`.

## CSV layout

One row per employee, per labor class, per day worked. Header row required. See `samples/week1.csv`.

Header columns (same on every row): `vendor_id, contract_id, payroll_number, period_begin, period_end, fringe_type`

Employee columns: `last_name, first_name, middle_initial, ssn, employee_id, gender, ethnicity`

Labor columns: `craft_code, labor_class, project_id, apprentice, st_rate, ot_rate`

Day columns: `work_date, st_hours, ot_hours`

Totals columns (same on every row for one employee and labor class): `gross_pay, total_deductions, net_pay, fica, federal_tax, state_tax, medicare, other_deductions`

`other_deductions` is `description:amount` pairs separated by `;`. Leave it empty when there are none.

Code values for `gender`, `ethnicity`, `fringe_type`, `craft_code` and `labor_class` come from your state's own list. The tool passes them through. It does not invent them. The sample uses Wisconsin's codes (craft 100 Laborers, labor class 101 Laborer Group 1, ethnicity HISP and A-IN) as they appear on the WisDOT spreadsheet template v3.

## Where this fits

Today's road on a state highway job: your payroll system, then hand entry into the state's Excel template (Wisconsin's is one form per employee, fifty blocks), then the web converter, then the import, then the error log. This tool replaces the middle. Export a flat CSV from payroll, convert, check, upload.

States that import this format through their AASHTOWare Project Civil Rights and Labor module include Wisconsin, Ohio, Alaska, Louisiana, Oklahoma, Connecticut and West Virginia (each state publishes its own contractor payroll page and its own code lists). If your state is not listed and imports Payroll XML, open an issue with a link to its page.

## Schema

The schema files are published by AASHTO at xml.aashtowareproject.org (Payroll XML Resource Kit). They are not redistributed here. `fetch_schemas` downloads them into `schemas/`.

## Why open source

Certified payroll is a public obligation on public money. The format is public. The tool to meet it should be too.

## License

MIT. See LICENSE.
