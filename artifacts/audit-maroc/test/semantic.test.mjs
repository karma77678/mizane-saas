/**
 * Offline tests for the browser side of the Level 2 (semantic AI) audit: batching by document,
 * turning predictions into findings, and saving / reloading a decision through the constats table.
 *
 *   node --test artifacts/audit-maroc/test/semantic.test.mjs
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSemanticBatches,
  enrichLevel1Finding,
  level1Match,
  referenceBase,
  parseSemanticCellReference,
  semanticCellReference,
  semanticFinding,
  semanticItemFromConstat,
  semanticRowPayload,
} from "../src/lib/semantic.ts";

let sourceRow = 1;
const entry = (id, reference, accountCode = "6111", debit = 100, credit = 0) => ({
  id, date: "2026-03-04", journal: "ACH", accountCode, accountLabel: "Achats", reference, description: `Ligne ${id}`, debit, credit, sourceFile: "client-confidentiel.xlsx", sourceRow: ++sourceRow,
});
const ENTRIES = [entry("a1", "FAC-1"), entry("b1", "FAC-2"), entry("a2", "FAC-1", "441100", 0, 100), entry("c1", ""), entry("b2", "FAC-2", "441100", 0, 100)];
const prediction = (rowIndices, code = "IA-LIB-01") => ({ code, title: "Libellé incohérent avec le compte imputé", severity: "medium", confidence: "moyenne", explanation: "Le libellé ne correspond pas au compte.", rowIndices, amount: 100 });

describe("buildSemanticBatches", () => {
  const all = ENTRIES.map((_, index) => index);
  it("keeps the rows of one document in the same batch", () => {
    const batches = buildSemanticBatches(ENTRIES, all, 2);
    assert.deepEqual(batches, [[0, 2], [1, 4], [3]]);
  });
  it("never exceeds the batch size, even for a document larger than one batch", () => {
    const big = Array.from({ length: 7 }, (_, index) => entry(`x${index}`, "FAC-BIG"));
    const batches = buildSemanticBatches(big, big.map((_, index) => index), 3);
    assert.deepEqual(batches.map((batch) => batch.length), [3, 3, 1]);
    assert.deepEqual(batches.flat(), [0, 1, 2, 3, 4, 5, 6]);
  });
  it("only covers the indices of the chosen scope", () => {
    assert.deepEqual(buildSemanticBatches(ENTRIES, [1, 3], 50), [[1, 3]]);
  });
});

describe("semanticRowPayload", () => {
  it("does not send the file name", () => {
    const payload = semanticRowPayload(ENTRIES[0], 0);
    assert.equal(payload.index, 0);
    assert.ok(!JSON.stringify(payload).includes("client-confidentiel"));
  });
});

describe("semanticFinding", () => {
  it("builds a stable, rule-prefixed ID from the rows, whatever their order", () => {
    const first = semanticFinding(prediction([0, 2]), ENTRIES);
    const second = semanticFinding(prediction([2, 0, 2]), ENTRIES);
    assert.equal(first.id, second.id);
    assert.ok(first.id.startsWith("IA-LIB-01-"));
    assert.deepEqual(first.sourceRowIds, ["a1", "a2"]);
    assert.equal(first.origin, "semantic");
    assert.equal(first.status, "open");
  });
  it("refuses a prediction with no existing row or a non IA code", () => {
    assert.equal(semanticFinding(prediction([99]), ENTRIES), null);
    assert.equal(semanticFinding(prediction([0], "BAL-01"), ENTRIES), null);
  });
});

describe("saving a decision in the constats table", () => {
  it("round-trips the decision, confidence and source rows", () => {
    const rows = [ENTRIES[0], ENTRIES[2]];
    const reference = semanticCellReference("merged", "élevée", rows);
    assert.equal(reference, `Niveau 2 IA · fusionné · confiance élevée · lignes ${rows[0].sourceRow}, ${rows[1].sourceRow}`);
    assert.deepEqual(parseSemanticCellReference(reference), { decision: "merged", confidence: "élevée", sourceRows: [rows[0].sourceRow, rows[1].sourceRow] });
    assert.equal(parseSemanticCellReference("Ligne 4, colonne Débit"), null);
  });
  it("rebuilds the finding from a saved constat", () => {
    const finding = semanticFinding(prediction([0, 2]), ENTRIES);
    const record = {
      id: finding.id, importId: "imp-1", ruleCode: "IA-LIB-01", severity: "medium", amount: 100,
      explanation: `${finding.title} — ${finding.explanation}`,
      cellReference: semanticCellReference("rejected", "moyenne", [ENTRIES[0], ENTRIES[2]]),
    };
    const item = semanticItemFromConstat(record, ENTRIES);
    assert.equal(item.decision, "rejected");
    assert.equal(item.datasetId, "imp-1");
    assert.equal(item.finding.title, finding.title);
    assert.equal(item.finding.explanation, finding.explanation);
    assert.deepEqual(item.finding.sourceRowIds, finding.sourceRowIds);
    assert.equal(item.finding.confidence, "moyenne");
  });
  it("round-trips the Level 1 constat a prediction was folded into", () => {
    const reference = semanticCellReference("merged", "moyenne", [ENTRIES[0]], "FISC-02-0123456789abcdef");
    assert.equal(parseSemanticCellReference(reference).mergedInto, "FISC-02-0123456789abcdef");
    const finding = semanticFinding(prediction([0], "IA-DED-01"), ENTRIES);
    const item = semanticItemFromConstat({ id: finding.id, importId: "imp-1", ruleCode: "IA-DED-01", severity: "medium", amount: 100, explanation: "t — e", cellReference: reference }, ENTRIES);
    assert.equal(item.decision, "merged");
    assert.equal(item.mergedInto, "FISC-02-0123456789abcdef");
    assert.equal(semanticCellReference("rejected", "moyenne", [ENTRIES[0]], "FISC-02-x").includes("dans"), false);
  });
  it("ignores Level 1 constats and saved rows that no longer exist", () => {
    const base = { id: "x", importId: "imp-1", severity: "high", amount: 0, explanation: "t — e" };
    assert.equal(semanticItemFromConstat({ ...base, ruleCode: "FISC-03", cellReference: "Ligne 3, colonne Débit" }, ENTRIES), null);
    assert.equal(semanticItemFromConstat({ ...base, ruleCode: "IA-LIB-01", cellReference: "Niveau 2 IA · fusionné · confiance faible · lignes 900" }, ENTRIES), null);
  });
});

describe("referenceBase", () => {
  it("strips copy markers but keeps distinct document numbers apart", () => {
    for (const copy of ["FAC-118-BIS", "FAC-118 bis", "FAC-118-DUP", "FAC-118 v2", "FAC-118 (copie)", "FAC-118-2", "fac 118"]) {
      assert.equal(referenceBase(copy), referenceBase("FAC-118"), copy);
    }
    assert.notEqual(referenceBase("FAC-2"), referenceBase("FAC-3"));
  });
});

describe("buildSemanticBatches with likely duplicates", () => {
  it("puts a suffixed copy and a same-amount document within five days in the batch of the original", () => {
    const rows = [
      { ...entry("o1", "FAC-118", "6133", 4800), date: "2026-03-12" },
      ...Array.from({ length: 3 }, (_, index) => ({ ...entry(`f${index}`, `ZZ-${index}`, "6111", 10 + index), date: "2026-03-12" })),
      { ...entry("o2", "FAC-118-BIS", "6133", 4800), date: "2026-03-14" },
      { ...entry("m1", "MNT-77", "6133", 2500), date: "2026-04-01", description: "Maintenance climatisation siège" },
      { ...entry("m2", "MNT-91", "6133", 2500), date: "2026-04-05", description: "Maintenance clim bureau principal" },
      { ...entry("m3", "MNT-99", "6133", 2500), date: "2026-05-30" },
    ];
    const batches = buildSemanticBatches(rows, rows.map((_, index) => index), 3);
    const batchOf = (index) => batches.findIndex((batch) => batch.includes(index));
    assert.equal(batchOf(0), batchOf(4));
    assert.equal(batchOf(5), batchOf(6));
    assert.ok(batches.every((batch) => batch.length <= 3));
    assert.deepEqual(batches.flat().sort((a, b) => a - b), rows.map((_, index) => index));
  });
});

describe("merging an accepted prediction into Level 1", () => {
  const penalty = { ...entry("p1", "PEN-9", "6585", 3200), description: "Pénalité de retard DGI" };
  const counterpart = entry("p2", "PEN-9", "441100", 0, 3200);
  const laptop = { ...entry("s1", "FAC-500", "6131", 18000), description: "Serveur Dell" };
  const rows = [penalty, counterpart, laptop];
  const level1 = (ruleCode, sourceRowIds) => ({ id: `${ruleCode}-x`, ruleCode, severity: "high", title: ruleCode, explanation: `Constat ${ruleCode}`, sourceRowIds, amount: 3200, suggestion: "", status: "open" });
  const fisc = level1("FISC-02", ["p1"]);
  const missingRef = level1("ECR-06", ["p1"]);
  const balance = level1("BAL-01", ["p1", "p2", "s1"]);

  it("case A: finds the Level 1 constat on the same line, preferring the related rule", () => {
    const ded = semanticFinding(prediction([0, 1], "IA-DED-01"), rows);
    assert.equal(level1Match(ded, [missingRef, fisc, balance], rows).id, "FISC-02-x");
  });
  it("case A: a shared document number is enough", () => {
    const ded = semanticFinding(prediction([1], "IA-DED-01"), rows);
    assert.equal(level1Match(ded, [fisc], rows).id, "FISC-02-x");
  });
  it("case B: a new anomaly, or one only covered by an account-wide rule, has no match", () => {
    const imm = semanticFinding(prediction([2], "IA-IMM-01"), rows);
    assert.equal(level1Match(imm, [fisc, balance], rows), null);
  });
  it("folds the AI reading into the Level 1 explanation, keeping one constat", () => {
    const ded = { ...semanticFinding(prediction([0], "IA-DED-01"), rows), explanation: "Le libellé « Pénalité de retard DGI » indique une charge non déductible." };
    const enriched = enrichLevel1Finding(fisc, [ded]);
    assert.equal(enriched.id, fisc.id);
    assert.equal(enriched.ruleCode, "FISC-02");
    assert.ok(enriched.explanation.startsWith("Constat FISC-02"));
    assert.match(enriched.explanation, /Analyse IA Niveau 2 \(IA-DED-01, confiance moyenne\) : Le libellé « Pénalité de retard DGI »/);
    assert.deepEqual(enriched.mergedSemantic.map((item) => item.ruleCode), ["IA-DED-01"]);
    assert.equal(enrichLevel1Finding(fisc, []), fisc);
  });
});
