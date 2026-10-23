/**
 * Offline tests for the Level 2 semantic review: row cleaning, compact input and the server
 * checks applied to the model's answer. No network, no database.
 *
 *   node --test artifacts/api-server/test/semantic-review.test.mjs
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSET_THRESHOLD_MAD,
  buildSemanticInput,
  duplicateLeads,
  MAX_SEMANTIC_FINDINGS,
  MAX_SEMANTIC_ROWS,
  reviewSemanticAnswer,
  sanitizeSemanticRows,
  SEMANTIC_RULES,
  SEMANTIC_SYSTEM_PROMPT,
  semanticSchema,
} from "../src/lib/semantic-review.ts";

const row = (index, accountCode, description, debit, credit, reference = "FAC-2026-301") => ({
  index, date: "2026-03-04", accountCode, accountLabel: "", reference, description, debit, credit,
});
// A restaurant bill booked as goods purchases with recovered VAT.
const RESTAURANT = [
  row(10, "6111", "Restaurant La Sqala - déjeuner clients", 1000, 0),
  row(11, "345520", "TVA restaurant", 100, 0),
  row(12, "441100", "Restaurant La Sqala", 0, 1100),
];

describe("sanitizeSemanticRows", () => {
  it("cleans text and amounts", () => {
    const [cleaned] = sanitizeSemanticRows([{ index: 3, date: "2026-01-01", accountCode: " 6111\n", description: "a\u0000b", debit: "12.345", credit: "x" }]);
    assert.deepEqual(cleaned, { index: 3, date: "2026-01-01", accountCode: "6111", accountLabel: "", reference: "", description: "a b", debit: 12.35, credit: 0 });
  });
  it("refuses empty, oversized, duplicated or non-integer batches", () => {
    assert.equal(sanitizeSemanticRows([]), null);
    assert.equal(sanitizeSemanticRows("rows"), null);
    assert.equal(sanitizeSemanticRows(Array.from({ length: MAX_SEMANTIC_ROWS + 1 }, (_, index) => row(index, "6111", "", 1, 0))), null);
    assert.equal(sanitizeSemanticRows([row(1, "6111", "", 1, 0), row(1, "6111", "", 1, 0)]), null);
    assert.equal(sanitizeSemanticRows([row(1.5, "6111", "", 1, 0)]), null);
  });
});

describe("buildSemanticInput", () => {
  it("sends one compact array per row, with no file or client name", () => {
    const input = buildSemanticInput(RESTAURANT, 2026);
    assert.equal(input.fiscalYear, 2026);
    assert.equal(input.columns.length, input.rows[0].length);
    assert.deepEqual(input.rows[0], [10, "2026-03-04", "6111", "", "FAC-2026-301", "Restaurant La Sqala - déjeuner clients", 1000, 0]);
    assert.ok(!JSON.stringify(input).includes("sourceFile"));
  });
});

describe("semanticSchema", () => {
  it("only lets the model pick a known code", () => {
    assert.deepEqual(semanticSchema.properties.findings.items.properties.code.enum, Object.keys(SEMANTIC_RULES));
  });
});

describe("reviewSemanticAnswer", () => {
  const good = { code: "IA-TVA-01", severity: "high", confidence: "élevée", explanation: "Le libellé « Restaurant La Sqala » porte de la TVA récupérée en 345520.", rowIndices: [12, 10, 11, 10] };

  it("keeps a valid prediction, with our title and an amount computed from the cited rows", () => {
    const { findings, discarded } = reviewSemanticAnswer({ findings: [good], coverageNote: "Lot lu." }, RESTAURANT);
    assert.equal(discarded, 0);
    assert.deepEqual(findings[0], {
      code: "IA-TVA-01", title: SEMANTIC_RULES["IA-TVA-01"], severity: "high", confidence: "élevée",
      explanation: good.explanation, rowIndices: [10, 11, 12], amount: 1100,
    });
  });
  it("drops row indices that were not in the batch, and the finding if none is left", () => {
    const partly = reviewSemanticAnswer({ findings: [{ ...good, rowIndices: [10, 99] }] }, RESTAURANT);
    assert.deepEqual(partly.findings[0].rowIndices, [10]);
    assert.equal(partly.findings[0].amount, 1000);
    const invented = reviewSemanticAnswer({ findings: [{ ...good, rowIndices: [99, 100] }] }, RESTAURANT);
    assert.equal(invented.findings.length, 0);
    assert.equal(invented.discarded, 1);
  });
  it("drops unknown codes, unknown severities and empty explanations", () => {
    const { findings, discarded } = reviewSemanticAnswer({ findings: [
      { ...good, code: "BAL-01" },
      { ...good, code: "constructor" },
      { ...good, severity: "critical" },
      { ...good, explanation: "   " },
    ] }, RESTAURANT);
    assert.equal(findings.length, 0);
    assert.equal(discarded, 4);
  });
  it("defaults a missing confidence to faible and removes duplicates", () => {
    const { findings, discarded } = reviewSemanticAnswer({ findings: [{ ...good, confidence: "certaine" }, good] }, RESTAURANT);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].confidence, "faible");
    assert.equal(discarded, 1);
  });
  it("caps the number of findings", () => {
    const many = Array.from({ length: MAX_SEMANTIC_FINDINGS + 5 }, (_, index) => ({ ...good, rowIndices: [10 + (index % 3)], explanation: `Indice ${index}` , code: Object.keys(SEMANTIC_RULES)[index % 7] }));
    assert.ok(reviewSemanticAnswer({ findings: many }, RESTAURANT).findings.length <= MAX_SEMANTIC_FINDINGS);
  });
  it("survives a malformed answer", () => {
    assert.deepEqual(reviewSemanticAnswer(null, RESTAURANT), { findings: [], coverageNote: "", discarded: 0 });
    assert.deepEqual(reviewSemanticAnswer({ findings: "none" }, RESTAURANT).findings, []);
  });
});

describe("Level 2 independence and universal rules", () => {
  it("no longer tells the model to skip what Level 1 controls", () => {
    assert.ok(!/Ne signale PAS/.test(SEMANTIC_SYSTEM_PROMPT));
    assert.match(SEMANTIC_SYSTEM_PROMPT, /examine CHAQUE ligne/);
  });
  it("covers fuzzy duplicates, asset reclassification, cut-off, deductibility and VAT", () => {
    for (const code of ["IA-DUP-01", "IA-IMM-01", "IA-PER-01", "IA-DED-01", "IA-TVA-01"]) {
      assert.ok(Object.hasOwn(SEMANTIC_RULES, code), code);
      assert.ok(SEMANTIC_SYSTEM_PROMPT.includes(code), code);
    }
    assert.match(SEMANTIC_SYSTEM_PROMPT, /-BIS/);
    assert.match(SEMANTIC_SYSTEM_PROMPT, /5 jours/);
    assert.match(SEMANTIC_SYSTEM_PROMPT, new RegExp(`${ASSET_THRESHOLD_MAD} MAD`));
    assert.match(SEMANTIC_SYSTEM_PROMPT, /classe 2/);
    assert.match(SEMANTIC_SYSTEM_PROMPT, /prest Q4 2025/);
  });
});

describe("duplicateLeads", () => {
  const dup = [
    { ...row(0, "6133", "Maintenance climatisation siège", 2500, 0, "MNT-77"), date: "01/04/2026" },
    { ...row(1, "441100", "Fournisseur clim", 0, 2500, "MNT-77"), date: "01/04/2026" },
    { ...row(2, "6133", "Maintenance clim bureau principal", 2520, 0, "MNT-91"), date: "2026-04-05" },
    { ...row(3, "6133", "Maintenance clim", 2500, 0, "MNT-99"), date: "2026-05-30" },
    { ...row(4, "6111", "Achat", 2500, 0, "FAC-1"), date: "2026-04-02" },
  ];
  it("pairs same-account, same-side amounts within 2 % and five days only", () => {
    assert.deepEqual(duplicateLeads(dup), [[0, 2]]);
  });
  it("is sent to the model with the asset threshold", () => {
    const input = buildSemanticInput(dup, 2026);
    assert.deepEqual(input.pistesDoublons, [[0, 2]]);
    assert.equal(input.seuilImmobilisationMAD, ASSET_THRESHOLD_MAD);
  });
});
