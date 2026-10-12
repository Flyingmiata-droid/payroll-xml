/*
  The made-up export the mapper page offers as a sample. MIT license.
  Same bytes as samples/exports/hours by pay type.csv, samples/exports/pay totals.csv and samples/exports/ny week.csv;
  tests/mapper_cases.js checks that. The people and numbers are invented.
*/
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.prlmapSamples = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var HOURS_CSV = [
    "Date,Employee,Job,Cost Code,Pay Class,Pay ID,Units,Rate,Description",
    "10/05/2026,\"Garcia, Luis A\",9999-01-01,01-100,Laborer Group 1,REG,8.00,28.50,",
    "10/05/2026,\"Garcia, Luis A\",SHOP,00-000,Shop,REG,2.00,22.00,yard cleanup",
    "10/06/2026,\"Garcia, Luis A\",9999-01-01,01-100,Laborer Group 1,REG,8.00,28.50,",
    "10/07/2026,\"Garcia, Luis A\",9999-01-01,01-100,Laborer Group 1,REG,8.00,28.50,",
    "10/07/2026,\"Garcia, Luis A\",9999-01-01,01-100,Laborer Group 1,OT,1.00,42.75,",
    "10/08/2026,\"Garcia, Luis A\",9999-01-01,01-100,Laborer Group 1,REG,8.00,28.50,",
    "10/09/2026,\"Garcia, Luis A\",9999-01-01,01-100,Laborer Group 1,REG,8.00,28.50,",
    "10/05/2026,\"Nguyen, Tran\",9999-01-01,02-200,Carpenter,REG,8.00,34.10,",
    "10/06/2026,\"Nguyen, Tran\",9999-01-01,02-200,Carpenter,REG,8.00,34.10,",
    "10/07/2026,\"Nguyen, Tran\",9999-01-01,02-200,Carpenter,REG,8.00,34.10,",
    "10/08/2026,\"Nguyen, Tran\",9999-01-01,02-200,Carpenter,REG,8.00,34.10,",
    "10/09/2026,\"Nguyen, Tran\",9999-01-01,02-200,Carpenter,REG,4.00,34.10,",
    "10/09/2026,\"Nguyen, Tran\",9999-01-01,02-200,Carpenter,REG,4.00,34.10,afternoon",
    "10/12/2026,\"Nguyen, Tran\",9999-01-01,02-200,Carpenter,REG,8.00,34.10,next week",
    ""
  ].join("\n");
  var TOTALS_CSV = [
    "Employee last name,Employee first name,Gross earnings,Social Security,Federal Income Tax,State Income Tax,Medicare,Union dues,Total deductions,Net pay",
    "Garcia,Luis,\"1,239.75\",76.86,148.00,0.00,17.98,38.37,281.21,958.54",
    "Nguyen,Tran,\"1,364.00\",84.57,160.00,0.00,19.78,48.09,312.44,\"1,051.56\"",
    "Okafor,Ada,900.00,55.80,90.00,0.00,13.05,0.00,158.85,741.15",
    "Totals,,\"3,503.75\",217.23,398.00,0.00,50.81,86.46,752.50,\"2,751.25\"",
    ""
  ].join("\n");
  // samples/exports/ny week.csv: a New York week, with home addresses and birth dates in the export.
  var NY_CSV = [
    "Employee,SSN,Birth Date,Address,Address 2,City,State,Zip,Apprentice,Date,Classification,Reg Hours,OT Hours,Reg Rate,OT Rate,Gross,Federal Withholding,State Withholding,Social Security,Medicare,Net Pay",
    "\"Lopez, Maria A\",XXX-XX-4821,,41 Elm St,,Albany,NY,12207-0002,N,9/28/2026,Laborer,8.00,0.00,45.00,67.50,\"1,935.00\",210.00,85.00,119.97,28.06,\"1,491.97\"",
    "\"Lopez, Maria A\",XXX-XX-4821,,41 Elm St,,Albany,NY,12207-0002,N,9/29/2026,Laborer,8.00,0.00,45.00,67.50,\"1,935.00\",210.00,85.00,119.97,28.06,\"1,491.97\"",
    "\"Lopez, Maria A\",XXX-XX-4821,,41 Elm St,,Albany,NY,12207-0002,N,9/30/2026,Laborer,8.00,0.00,45.00,67.50,\"1,935.00\",210.00,85.00,119.97,28.06,\"1,491.97\"",
    "\"Lopez, Maria A\",XXX-XX-4821,,41 Elm St,,Albany,NY,12207-0002,N,10/1/2026,Laborer,8.00,0.00,45.00,67.50,\"1,935.00\",210.00,85.00,119.97,28.06,\"1,491.97\"",
    "\"Lopez, Maria A\",XXX-XX-4821,,41 Elm St,,Albany,NY,12207-0002,N,10/2/2026,Laborer,8.00,2.00,45.00,67.50,\"1,935.00\",210.00,85.00,119.97,28.06,\"1,491.97\"",
    "\"O'Neill, James\",,4/17/1999,9 River Rd,Apt 2,Fort Lee,NJ,07024,Y,9/28/2026,Carpenter,8.00,0.00,38.00,57.00,\"1,612.00\",150.00,60.00,99.94,23.37,\"1,278.69\"",
    "\"O'Neill, James\",,4/17/1999,9 River Rd,Apt 2,Fort Lee,NJ,07024,Y,9/29/2026,Carpenter,8.00,0.00,38.00,57.00,\"1,612.00\",150.00,60.00,99.94,23.37,\"1,278.69\"",
    "\"O'Neill, James\",,4/17/1999,9 River Rd,Apt 2,Fort Lee,NJ,07024,Y,9/30/2026,Carpenter,8.00,0.00,38.00,57.00,\"1,612.00\",150.00,60.00,99.94,23.37,\"1,278.69\"",
    "\"O'Neill, James\",,4/17/1999,9 River Rd,Apt 2,Fort Lee,NJ,07024,Y,10/1/2026,Carpenter H&H,8.00,1.00,40.00,60.00,\"1,612.00\",150.00,60.00,99.94,23.37,\"1,278.69\"",
    "\"O'Neill, James\",,4/17/1999,9 River Rd,Apt 2,Fort Lee,NJ,07024,Y,10/2/2026,Carpenter H&H,8.00,0.00,40.00,60.00,\"1,612.00\",150.00,60.00,99.94,23.37,\"1,278.69\"",
    ""
  ].join("\n");
  // What a person would type for the New York sample. The worker details are all in the export.
  function fillNy(setup) {
    setup.target = "ny";
    setup.payroll.prc_number = "2025001234";
    setup.payroll.period_begin = "2026-09-28";
    setup.classes = {
      "Laborer": { work_category: "Laborer - Building", health: "12.50", pension: "9.75", training: "0.80" },
      "Carpenter": { work_category: "Carpenter - Building", health: "11.00", other: "1.50", other_explanation: "Annuity" },
      "Carpenter H&H": { work_category: "Carpenter - Heavy and Highway", health: "11.00" }
    };
    return setup;
  }
  // What a person would type for this sample after the page has guessed the columns.
  function fill(setup) {
    setup.payroll = { vendor_id: "V1001", contract_id: "20260001", payroll_number: "1", period_begin: "2026-10-04", fringe_type: "Cash", project_id: "9999-01-01" };
    setup.jobs = ["9999-01-01"];
    setup.otRule = "x1.5";
    setup.totals.otherDeductionCols = ["Union dues"];
    setup.classes = {
      "Laborer Group 1": { craft_code: "100", labor_class: "101" },
      "Carpenter": { craft_code: "200", labor_class: "201" }
    };
    setup.people = {
      "name:garcia|luis": { ssn: "1234", employee_id: "E01", gender: "Male", ethnicity: "HISP" },
      "name:nguyen|tran": { ssn: "5678", employee_id: "E02", gender: "Female", ethnicity: "A-IN" }
    };
    return setup;
  }
  return { HOURS_CSV: HOURS_CSV, TOTALS_CSV: TOTALS_CSV, NY_CSV: NY_CSV, fill: fill, fillNy: fillNy };
});
