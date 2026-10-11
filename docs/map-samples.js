/*
  The made-up export the mapper page offers as a sample. MIT license.
  Same bytes as samples/exports/hours by pay type.csv and samples/exports/pay totals.csv;
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
  return { HOURS_CSV: HOURS_CSV, TOTALS_CSV: TOTALS_CSV, fill: fill };
});
