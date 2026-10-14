Open source converter and checker for certified payroll XML, the Payroll XML 1.2 format (TransXML based) that state DOT systems import for Davis-Bacon highway jobs.

Today a small contractor on a state highway job fills a state spreadsheet by hand every week, uploads it to a web converter, imports the XML, reads the error log, fixes the spreadsheet, and does it all again. This tool does the convert step and the error step on your own machine, before the upload.

Status: version 0, built 2026-10-10. An earlier `samples/week1.xml`, written by this tool, passed the official AASHTOWare Project online Payroll XML validator on 2026-10-10 ("The source document is valid Payroll XML"). The current sample adds the `grossProjectAmountEarned` field and passes the published schema. No file from this tool has been run through a state import yet. Treat it as a prototype until one has.

## What it does

`convert` turns a flat CSV (one row per employee, per labor class, per day) into a Payroll XML file. It fills blank hours with 0.00 and strips dashes from SSNs on the way. Rates, weekly totals, gender and the other values the XML holds once per worker must match on every row for that worker; if one differs, convert stops and names the row instead of keeping the first value. It writes `grossProjectAmountEarned`, which the field definitions require even though the schema marks it optional: the `project_gross` column if you give one, otherwise the rates times the hours plus any lump sum. The state spreadsheets also fill this field in for you. Rates keep the decimals you typed, up to 3 for straight time and 4 for overtime, as the field definitions allow.

`check` validates a Payroll XML file against the published schema, then runs plain-English rules taken from the official AASHTO Payroll XML Project Field Definitions (resource kit 2.1) and from state import pages. It works on Payroll XML from any tool, including the files your payroll software exports.

Rule errors are things the field definitions require or a state import rejects. Most of them pass the schema, so a schema validator will not catch them.

- a payroll number of 1 or more, a seven-day period, and every day worked inside it
- straight time hours on every day (0.00 when none), no hours below 0, and daily hours that add up to the straight time, overtime and total hours
- a straight time rate above 0 and an overtime rate on every hourly line (above 0 when there is overtime), and neither on a salaried one
- total hours, straight time hours, gross pay, deductions, net pay and `grossProjectAmountEarned` on every labor line
- gross pay minus deductions equal to net pay
- an employee ID of some kind, an SSN with no dashes, a one-character middle initial, gender as Male or Female
- a fringe type of Cash, Plan Funds, or Plan Funds with Exceptions
- apprentice ID and wage percentage on apprentice lines, OJT wage percentage on OJT lines
- fringe rates above 0, one description per other deduction, and complete fringe benefit programs with a valid type
- the field length limits

Warnings are things a state reviewer would question, or that some states reject depending on their agency options. They print as `WARN` and do not change the exit code.

- pay below the hours times the rates
- taxes and other deductions that do not add up to the total deductions, or gross pay below the project pay
- the same day twice on one labor line, or more than 24 hours in one day
- an overtime rate of 0.00, or below the straight time rate
- a day with no overtime field (Wisconsin wants 0.00)
- a worker with no hours, or one name listed as two workers
- a Plan Funds line with no fringe rate

## Quick start

    python -m prlxml.fetch_schemas
    python -m prlxml.convert samples/week1.csv -o week1.xml
    python -m prlxml.check week1.xml

### Several weeks at once

    python -m prlxml.check week*.xml

`check` takes as many files as you give it. It checks each one, then warns when two files for the same vendor and contract carry the same payroll number, or cover any of the same days. Those are warnings: a correction can share a week on purpose. The exit code is 1 when any file has an error. The browser page does the same when you drop several files at once.

Needs Python 3.10 or newer and `lxml`.

## In your browser

Use it at https://flyingmiata-droid.github.io/payroll-xml/

`docs/index.html` is the same converter and the same rule checks as one web page. Open it, drop a CSV or a Payroll XML file, and download the XML. Drop several and it lists each file's result, plus any two files that clash. Everything runs in the browser tab. The page sends nothing anywhere, and its content security policy blocks every outside request, so SSNs stay on the machine.

The page does not run the schema check, because the AASHTO schema files are not redistributed here. For that, use the Python tool or the official online validator at https://xml.aashtowareproject.org/resourcekit/validator.html.

The page gives the same answers as the Python tool. `tests/test_web.py` runs both on a set of CSV and XML cases and compares them: converted XML byte for byte, rule, warning and convert messages word for word. A file the XML parser cannot read is refused by both, in the parser's own words, so that wording differs. The test needs Node and `@xmldom/xmldom` and skips without them.

To use it from a copy of this repo, open `docs/index.html` in a browser. No server needed.

## Start from your payroll export

`docs/map.html` is a second page, for the file your payroll system already exports: https://flyingmiata-droid.github.io/payroll-xml/map.html

Drop the export as a CSV, with whatever column names it has. The page guesses which column is which and you correct it. You type what a payroll export does not carry: the vendor ID, contract ID, payroll number and pay week, and your state's craft code and labor class for each of your classifications. Then it converts, runs the same rule check, and gives you the XML. Save the setup as a file. Next week, load it with the new export and convert.

It reads days down the page or across it, straight time and overtime in their own columns or on their own rows, hours as 7.75 or 7:45, names in one column or two, and pay totals in the same file or in a second one. It leaves out rows for other jobs and for leave pay and tells you how many, and rows for other weeks when each row carries a date. It runs in the browser tab like the first page and sends nothing anywhere. A saved setup leaves out SSNs unless you tick the box that keeps them.

For New York public work, the same page writes the New York State DOL bulk upload file. Pick New York in step 3 and type the PRC number. For each classification, type the work category the way the prevailing rate schedule names it, and the supplement rates per hour. The worker's home address and the last 4 of the SSN or the birth date come from the export when it has them, or you type them in the workers table. Deductions go in by type: federal, state, FICA, Medicare and any other deduction columns you tick. The made-up sample `samples/exports/ny week.csv` comes out byte for byte as `samples/ny/week1.xml`.

This page is browser only. The Python tool does not have it yet. It has been tested on made-up exports built from the column layouts payroll systems publish (`samples/exports`, `tests/mapper_cases.js`). It has not been run on a real export. If yours does not match up, open an issue with the row of column names, and leave out names and SSNs.

## New York State DOL

Since January 1, 2026, New York has required contractors and subcontractors on public work to submit certified payroll through the NYS DOL Certified Payroll System, at least every 30 days. The bulk upload is its own XML format (`NYDOL_CertPayroll.xsd`), one file per project (PRC number) per week. It is not Payroll XML 1.2.

    python -m prlxml.fetch_schemas ny
    python -m prlxml.nydol convert samples/ny/week1.csv -o week1.xml
    python -m prlxml.nydol check week1.xml

`nydol check` also takes several files. It warns when two of them carry the same PRC number and week ending date.

In the browser: https://flyingmiata-droid.github.io/payroll-xml/ny.html (`docs/ny.html`). It has the same converter and rules as the Python tool, without the schema check. Nothing leaves the tab. `tests/test_nydol.py` holds the page and the Python tool to the same answers.

The CSV is one row per worker, per classification, per day. Columns: `prc_number, week_ending, last_name, first_name, middle_name, ssn_last4, date_of_birth, apprentice, address1, address2, city, state, zip, country, gross_earnings, net_wages, deductions, work_category, st_rate, ot_rate, work_date, st_hours, ot_hours`, plus optional hourly supplement rates `health, vacation, training, pension, other` (with `other_explanation`, and `_ot` columns when the overtime rate differs). See `samples/ny/week1.csv`. Give `ssn_last4` or `date_of_birth`, not both; a full SSN is cut to its last 4. Two letter states are spelled out, and a ZIP that Excel cut to 4 digits gets its leading 0 back.

The check runs the state schema, then rules for what the upload rejects that the schema lets through: SSN last 4 and date of birth both or neither, the same worker twice, a day outside the week, an abbreviated state, an Other Benefit supplement with no explanation (or an explanation on another type), negative hours, rates or pay, and a straight time rate of 0.00. It also names four places where the state's guide page and its schema disagree: the field is `deductionsGrossEarnings` with an s, the address needs a country, apprentice is true or false (not Y or N), and the week ending date carries a time. Warnings: gross minus deductions not equal to net, gross below the hours times the rates, a day twice, more than 24 hours in a day, overtime rate below straight time, a supplement for a classification the worker is not listed under, and a worker with no hours.

Status: `samples/ny/week1.xml`, written by this tool, passes the state's published schema as posted in October 2026. No file from this tool has been through the state's upload yet.

## CSV layout

One row per employee, per labor class, per day worked. Header row required. See `samples/week1.csv`.

Header columns (same on every row): `vendor_id, contract_id, payroll_number, period_begin, period_end, fringe_type`

Employee columns: `last_name, first_name, middle_initial, ssn, employee_id, gender, ethnicity`

Labor columns: `craft_code, labor_class, project_id, apprentice, st_rate, ot_rate`

Day columns: `work_date, st_hours, ot_hours`

Totals columns (same on every row for one employee and labor class): `gross_pay, total_deductions, net_pay, fica, federal_tax, state_tax, medicare, other_deductions`

`other_deductions` is `description:amount` pairs separated by `;`. Leave it empty when there are none.

Optional columns (leave them out, or blank, when they do not apply; same on every row for one employee and labor class): `project_gross` is the pay for this contract and project only, `lump_sum` is cash fringe or other cash paid on the line, and `apprentice_id` and `apprentice_pct` are needed when `apprentice` is yes.

Fringe paid to plans (Plan Funds), all optional:

- `health_rate`, `vacation_rate`, `apprenticeship_rate`, `pension_rate`, `other1_rate`, `other2_rate`: the hourly rate paid into each kind of plan for this employee and labor class. Dollars and cents only; a rate with a third decimal stops convert rather than being rounded. Blank or 0 leaves the rate out.
- `fringe_benefits`: the fringe paid on this line for the week.
- `health_program`, `vacation_program`, `apprenticeship_program`, `pension_program`, `other1_program`, `other2_program`: one program per kind, same on every row, written as `name | account ID | trustee | phone`. Add `| class` for Other 1 and Other 2, which the field definitions require there. For example `Laborers Health Fund | 55-1234 | Ann Lee | 608-555-0100`.

Rows where every cell is blank are skipped. Spreadsheet exports often end with a few rows of bare commas.

Excel habits it handles: dates saved as 10/4/2026 are read as 2026-10-04, a plain "CSV" save (Windows-1252) is read as well as "CSV UTF-8", float leftovers like -1.1E-13 come out as 0.00, and money saved as $1,239.75 is read as 1239.75. A comma that is not a thousands mark, like 8,0 for eight hours, stops convert instead of being read as 80. A file that mixes two text encodings is refused, so accented names never come out garbled. Excel can also turn a project number that looks like a date into a date; format that column as Text before you save.

`gender` takes Male or Female (M and F are mapped). `fringe_type` takes Cash, Plan Funds, or Plan Funds with Exceptions, in any case. Code values for `ethnicity`, `craft_code` and `labor_class` come from your state's own list. The tool passes them through. It does not invent them. The sample uses Wisconsin's codes (craft 100 Laborers, labor class 101 Laborer Group 1, ethnicity HISP and A-IN) as they appear on the WisDOT spreadsheet template v3.

## What it does not check

Your state's code lists, whether the project is on the contract, and the rates in the wage decision. The check compares the file's own numbers with each other, not with the prevailing wage. Convert writes fringe programs and rates, but not fringe benefit exceptions, so a Plan Funds with Exceptions payroll still needs those from your payroll system. Convert also takes one straight time and overtime rate pair per worker and labor class. A double time or shift rate needs its own labor line, which the CSV cannot hold yet, so convert stops and names the row.

## Where this fits

Today's road on a state highway job: your payroll system, then hand entry into the state's Excel template (Wisconsin's is one form per employee, fifty blocks), then the web converter, then the import, then the error log. This tool replaces the middle. Export a flat CSV from payroll, convert, check, upload.

States that import this format through their AASHTOWare Project Civil Rights and Labor module include Wisconsin, Ohio, Alaska, Louisiana, Oklahoma, Connecticut, West Virginia, Tennessee, Montana, Minnesota, Kansas and Oregon (each state publishes its own contractor payroll page and its own code lists). If your state is not listed and imports Payroll XML, open an issue with a link to its page.

## Schema

The schema files are published by AASHTO at xml.aashtowareproject.org (Payroll XML Resource Kit). They are not redistributed here. `fetch_schemas` downloads them into `schemas/`.

## Why open source

Certified payroll is a public obligation on public money. The format is public. The tool to meet it should be too.

## License

MIT. See LICENSE. The web page uses the Overpass typeface under the SIL Open Font License (docs/fonts/OFL.txt).
