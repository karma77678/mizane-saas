/**
 * Unit tests for the audit engine's FISC-03 finding (recoverable VAT rate
 * inconsistency): which lines it carries and how its ID and amount are built.
 * No database, no browser, no React.
 *
 *   node --test artifacts/audit-maroc/test/audit-engine.test.mjs
 *
 * The finding's source rows are what the AI correction receives: without the
 * supplier line, the model cannot name the real counterpart account. Its ID
 * keys the statuses saved by the cabinet, so it must not move.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAudit } from "../src/lib/audit-engine.ts";

const OPTIONS = { documentType: "grand-livre", fiscalYear: 2026, vatRates: [], vatCollectedPrefixes: [], vatRecoverablePrefixes: [] };
let sourceRow = 0;
const entry = (id, accountCode, debit, credit, reference = "FAC-2026-102") => ({
  id, date: "2026-02-10", journal: "ACH", accountCode, accountLabel: "", reference, description: "", debit, credit, sourceFile: "gl.csv", sourceRow: ++sourceRow,
});
/** FAC-2026-102: 1 000 HT, 300 of recoverable VAT (30 % instead of 20 %), supplier credited 1 300. */
const fac2026102 = (supplierId = "supplier") => [
  entry("charge", "6111", 1000, 0),
  entry("vat", "345520", 300, 0),
  entry(supplierId, "44110012", 0, 1300),
];
const fisc03 = (entries) => {
  const found = runAudit(entries, OPTIONS, {}).filter((finding) => finding.ruleCode === "FISC-03");
  assert.equal(found.length, 1);
  return found[0];
};

describe("FISC-03", () => {
  it("carries the whole document, charge and VAT lines first, so the supplier counterpart is known", () => {
    assert.deepEqual(fisc03(fac2026102()).sourceRowIds, ["charge", "vat", "supplier"]);
  });

  it("reports the VAT excess over the closest reference rate", () => {
    assert.equal(fisc03(fac2026102()).amount, 100);
  });

  it("reports an under-recorded VAT gap as an absolute amount", () => {
    // 170 on 1 000 is 17 %: the engine keeps 20 %, a 30 shortfall.
    const entries = [entry("charge", "6111", 1000, 0), entry("vat", "345520", 170, 0), entry("supplier", "44110012", 0, 1170)];
    assert.equal(fisc03(entries).amount, 30);
  });

  it("keeps its ID on the charge and VAT lines only, so saved statuses survive the wider context", () => {
    assert.equal(fisc03(fac2026102("supplier-a")).id, fisc03(fac2026102("supplier-b")).id);
  });

  it("keeps the charge and VAT lines within the 50-row limit of a long document", () => {
    const filler = Array.from({ length: 58 }, (_, i) => entry(`other-${i}`, "6111", 0, 0));
    const finding = fisc03([...filler, ...fac2026102()]);
    assert.equal(finding.sourceRowIds.length, 50);
    assert.deepEqual(finding.sourceRowIds.slice(0, 2), ["charge", "vat"]);
  });
});
