/**
 * Unit tests for the server-side checks applied to AI correction proposals.
 * No database, no network, no AI call: the proposals below are fixed, and
 * several are real wrong answers the model gave on the FA-102 example.
 *
 *   node --test artifacts/api-server/test/ai-correction.test.mjs
 *
 * These checks decide whether a generated journal entry is shown to the user
 * as a usable draft, so a regression here puts a wrong entry in front of them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCorrectionInput, entryIsRequired, reviewProposal, reviewProposalWithReason } from "../src/lib/ai-correction.ts";

/** FA-102: purchase 1 000 HT + 200 VAT on the debit side, supplier credited 1 000 only. */
const FA102_ROWS = [
  { date: "2025-03-12", accountCode: "6111", accountLabel: "Achats de marchandises", reference: "FA-102", description: "Achat fournisseur X", debit: 1000, credit: 0 },
  { date: "2025-03-12", accountCode: "34552", accountLabel: "État - TVA récupérable sur charges", reference: "FA-102", description: "TVA 20%", debit: 200, credit: 0 },
  { date: "2025-03-12", accountCode: "4411", accountLabel: "Fournisseurs", reference: "FA-102", description: "Fournisseur X", debit: 0, credit: 1000 },
];
const finding = (ruleCode) => ({ ruleCode, severity: "high", title: "Constat", explanation: "", amount: 200, suggestion: "" });
const line = (accountCode, debit, credit) => ({ accountCode, accountLabel: "", debit, credit, rationale: "" });
const proposal = (lines, confidence = "moyenne") => ({ description: "", journalEntry: lines, prerequisites: ["Vérifier la facture."], confidence, disclaimer: "Brouillon." });
const review = (lines, { ruleCode = "ECR-01", rows = FA102_ROWS, confidence, amount = 200 } = {}) =>
  reviewProposal(proposal(lines, confidence), buildCorrectionInput({ ...finding(ruleCode), amount }, rows));
const lastPrerequisite = (result) => result.prerequisites.at(-1);

function assertRejected(result, reason) {
  assert.deepEqual(result.journalEntry, []);
  assert.equal(result.confidence, "faible");
  assert.match(lastPrerequisite(result), reason);
}

describe("buildCorrectionInput", () => {
  it("asks to complete an unbalanced document for ECR-01", () => {
    const input = buildCorrectionInput(finding("ECR-01"), FA102_ROWS);
    assert.equal(input.correctionMode, "complete_document");
    assert.equal(input.sourceDifference, 200);
  });

  it("forbids any entry for BAL-01, whose extract may be partial", () => {
    assert.equal(buildCorrectionInput(finding("BAL-01"), FA102_ROWS).correctionMode, "no_entry");
  });

  it("forbids any entry for ECR-01 when the document may be truncated or is not actually unbalanced", () => {
    const fiftyRows = Array.from({ length: 50 }, () => FA102_ROWS[0]);
    assert.equal(buildCorrectionInput(finding("ECR-01"), fiftyRows).correctionMode, "no_entry");
    const balancedRows = [...FA102_ROWS.slice(0, 2), line("4411", 0, 1200)];
    assert.equal(buildCorrectionInput(finding("ECR-01"), balancedRows).correctionMode, "no_entry");
  });

  it("requires a balanced entry for the other findings", () => {
    assert.equal(buildCorrectionInput(finding("REG-01"), FA102_ROWS).correctionMode, "balanced_entry");
  });
});

describe("reviewProposal on FA-102 (ECR-01)", () => {
  it("keeps the correct completion: credit the supplier 200", () => {
    const result = review([line("4411", 0, 200)]);
    assert.deepEqual(result.journalEntry, [line("4411", 0, 200)]);
    assert.equal(result.confidence, "moyenne");
    assert.deepEqual(result.prerequisites, ["Vérifier la facture."]);
  });

  it("rejects debiting and crediting the same account", () => {
    assertRejected(review([line("34552", 200, 0), line("34552", 0, 200)]), /même compte/);
  });

  it("rejects a balanced entry that leaves the document unbalanced", () => {
    assertRejected(review([line("4456", 200, 0), line("34552", 0, 200)]), /ne rééquilibrent pas la pièce/);
  });

  it("rejects short French chart-of-accounts codes", () => {
    for (const account of ["401", "411", "512"]) {
      assertRejected(review([line(account, 0, 200)]), /hors du plan comptable marocain/);
    }
  });

  it("rejects a line with both debit and credit filled", () => {
    assertRejected(review([line("4411", 50, 250)]), /montants invalides/);
  });

  it("keeps a reversal of a source line, but with low confidence and a warning", () => {
    const result = review([line("34552", 0, 200)]);
    assert.equal(result.journalEntry.length, 1);
    assert.equal(result.confidence, "faible");
    assert.match(lastPrerequisite(result), /contrepasse en partie .* 34552/);
  });

  it("caps confidence and warns when the model introduces an account absent from the document", () => {
    const result = review([line("4455", 0, 200)], { confidence: "élevée" });
    assert.equal(result.journalEntry.length, 1);
    assert.equal(result.confidence, "moyenne");
    assert.match(lastPrerequisite(result), /absent\(s\) des lignes sources : 4455/);
  });
});

/**
 * FAC-2026-102: 1 000 HT of purchases with 300 of recoverable VAT, i.e. 30 % instead of 20 %.
 * The client sends the whole document for FISC-03, supplier line included (auxiliary account 44110012).
 */
const FAC_2026_102_ROWS = [
  { date: "2026-02-10", accountCode: "6111", accountLabel: "Achats de marchandises", reference: "FAC-2026-102", description: "Achat fournisseur Y", debit: 1000, credit: 0 },
  { date: "2026-02-10", accountCode: "345520", accountLabel: "État - TVA récupérable sur charges", reference: "FAC-2026-102", description: "TVA", debit: 300, credit: 0 },
  { date: "2026-02-10", accountCode: "44110012", accountLabel: "Fournisseur Y", reference: "FAC-2026-102", description: "Fournisseur Y", debit: 0, credit: 1300 },
];
const fisc03 = { ruleCode: "FISC-03", rows: FAC_2026_102_ROWS, amount: 100 };

describe("FISC-03 VAT rate error on FAC-2026-102", () => {
  it("recomputes the excess and requires a figured VAT adjustment", () => {
    const input = buildCorrectionInput({ ...finding("FISC-03"), amount: 100 }, FAC_2026_102_ROWS);
    assert.equal(input.correctionMode, "vat_adjustment");
    assert.equal(entryIsRequired(input), true);
    assert.deepEqual(input.vatAdjustment, {
      vatAccounts: ["345520"], chargeBase: 1000, recordedVat: 300, observedRate: 30, expectedRate: 20, expectedVat: 200, excess: 100,
    });
  });

  it("rejects text-only advice and states the expected correction", () => {
    const { proposal: result, rejection } = reviewProposalWithReason(proposal([]), buildCorrectionInput({ ...finding("FISC-03"), amount: 100 }, FAC_2026_102_ROWS));
    assertRejected(result, /écriture de régularisation chiffrée est exigée/);
    assert.match(rejection, /crédit de 100\.00 MAD sur le compte 345520 .*attendue 200\.00 MAD à 20 %/);
  });

  it("keeps the reversal of the excess against the document's supplier account, raising a low confidence to medium", () => {
    const lines = [line("44110012", 100, 0), line("345520", 0, 100)];
    const result = review(lines, { ...fisc03, confidence: "faible" });
    assert.deepEqual(result.journalEntry, lines);
    assert.equal(result.confidence, "moyenne");
    assert.deepEqual(result.prerequisites, ["Vérifier la facture."]);
  });

  it("keeps a high confidence when the supplier counterpart comes from the document", () => {
    const result = review([line("44110012", 100, 0), line("345520", 0, 100)], { ...fisc03, confidence: "élevée" });
    assert.equal(result.confidence, "élevée");
  });

  it("caps the confidence and warns when the generic 4411 replaces the document's supplier account", () => {
    const result = review([line("4411", 100, 0), line("345520", 0, 100)], { ...fisc03, confidence: "élevée" });
    assert.equal(result.journalEntry.length, 2);
    assert.equal(result.confidence, "moyenne");
    assert.match(lastPrerequisite(result), /absent\(s\) des lignes sources : 4411/);
  });

  it("keeps a high confidence when the counterpart is the document's own charge account", () => {
    const result = review([line("6111", 100, 0), line("345520", 0, 100)], { ...fisc03, confidence: "élevée" });
    assert.equal(result.journalEntry.length, 2);
    assert.equal(result.confidence, "élevée");
  });

  it("rejects an entry that does not move the VAT account by exactly the excess", () => {
    assertRejected(review([line("4411", 90, 0), line("345520", 0, 90)], fisc03), /ne régularise pas exactement l’écart de TVA/);
    assertRejected(review([line("4411", 100, 0), line("34552", 0, 100)], fisc03), /ne régularise pas exactement l’écart de TVA/);
  });

  it("still rejects an unbalanced VAT adjustment", () => {
    assertRejected(review([line("345520", 0, 100)], fisc03), /n’est pas équilibrée/);
  });

  it("expects a debit on the VAT account when VAT was under-recorded", () => {
    // 170 on 1 000 is 17 %, three points from both 14 % and 20 %: the engine keeps the first, 20 %.
    // The engine stores the finding amount as an absolute value, so the client sends 30, not -30.
    const rows = [FAC_2026_102_ROWS[0], { ...FAC_2026_102_ROWS[1], debit: 170 }, { ...FAC_2026_102_ROWS[2], credit: 1170 }];
    const input = buildCorrectionInput({ ...finding("FISC-03"), amount: 30 }, rows);
    assert.equal(input.correctionMode, "vat_adjustment");
    assert.equal(input.vatAdjustment.excess, -30);
    assert.equal(reviewProposal(proposal([line("345520", 30, 0), line("44110012", 0, 30)]), input).journalEntry.length, 2);
  });

  it("falls back to the general mode when the gap is not evident", () => {
    const fallback = (amount, rows) => buildCorrectionInput({ ...finding("FISC-03"), amount }, rows);
    // The finding was computed with rates configured by the cabinet, not the Moroccan ones.
    assert.equal(fallback(150, FAC_2026_102_ROWS).correctionMode, "balanced_entry");
    // A possibly truncated document.
    assert.equal(fallback(100, Array.from({ length: 50 }, (_, i) => FAC_2026_102_ROWS[i % 3])).correctionMode, "balanced_entry");
    // A rate within two points of 20 %.
    assert.equal(fallback(0, [FAC_2026_102_ROWS[0], { ...FAC_2026_102_ROWS[1], debit: 215 }]).vatAdjustment, null);
    // No VAT line at all.
    assert.equal(fallback(0, [FAC_2026_102_ROWS[0]]).correctionMode, "balanced_entry");
  });

  it("requires the exact adjustment on the figures reported from the web interface (10 000 HT, 3 000 VAT)", () => {
    const rows = [
      { ...FAC_2026_102_ROWS[0], debit: 10000 },
      { ...FAC_2026_102_ROWS[1], debit: 3000 },
      { ...FAC_2026_102_ROWS[2], accountCode: "441100", accountLabel: "Fournisseurs", credit: 13000 },
    ];
    const input = buildCorrectionInput({ ...finding("FISC-03"), amount: 1000 }, rows);
    assert.equal(input.correctionMode, "vat_adjustment");
    assert.equal(input.vatAdjustment.excess, 1000);
    const { proposal: textOnly, rejection } = reviewProposalWithReason(proposal([]), input);
    assertRejected(textOnly, /chiffrée est exigée/);
    assert.match(rejection, /crédit de 1000\.00 MAD sur le compte 345520/);
    const expected = [line("441100", 1000, 0), line("345520", 0, 1000)];
    const result = reviewProposal(proposal(expected, "élevée"), input);
    assert.deepEqual(result.journalEntry, expected);
    assert.equal(result.confidence, "élevée");
  });

  it("does not require a figured entry for the other findings", () => {
    assert.equal(entryIsRequired(buildCorrectionInput(finding("REG-01"), FA102_ROWS)), false);
  });
});

/**
 * DUP-01 as reported from the web interface. The client sends the identical lines of the duplicate group:
 * same account, same reference, same amounts, dates within three days.
 */
const dupRow = (date, accountCode, debit, credit) =>
  ({ date, accountCode, accountLabel: "", reference: "FAC-2026-210", description: "Facture fournisseur Z", debit, credit });
const SUPPLIER_CREDIT_TWICE = [dupRow("2026-03-01", "441100", 0, 1200), dupRow("2026-03-02", "441100", 0, 1200)];
const VAT_DEBIT_TWICE = [dupRow("2026-03-01", "345520", 200, 0), dupRow("2026-03-01", "345520", 200, 0)];
const dup01 = (rows) => ({ ruleCode: "DUP-01", rows });

describe("DUP-01 double recording", () => {
  it("asks to reverse the extra occurrence of a doubled supplier credit", () => {
    const input = buildCorrectionInput(finding("DUP-01"), SUPPLIER_CREDIT_TWICE);
    assert.equal(input.correctionMode, "reverse_duplicate");
    assert.equal(entryIsRequired(input), true);
    assert.deepEqual(input.duplicateReversal, { account: "441100", duplicatedSide: "credit", lineAmount: 1200, occurrences: 2, reversalAmount: 1200 });
  });

  it("rejects the reported answer that adds a charge against the supplier and worsens the duplicate", () => {
    const result = review([line("6220", 1200, 0), line("4411", 0, 1200)], dup01(SUPPLIER_CREDIT_TWICE));
    assertRejected(result, /ajoutait des lignes sur d’autres comptes \(6220, 4411\).*débit de 1200\.00 MAD sur le compte 441100/);
  });

  it("keeps the reversal of the doubled supplier credit, with at least a medium confidence", () => {
    const result = review([line("441100", 1200, 0)], { ...dup01(SUPPLIER_CREDIT_TWICE), confidence: "faible" });
    assert.deepEqual(result.journalEntry, [line("441100", 1200, 0)]);
    assert.equal(result.confidence, "moyenne");
    assert.deepEqual(result.prerequisites, ["Vérifier la facture."]);
  });

  it("rejects text-only advice on a doubled VAT line and states the expected reversal", () => {
    const { proposal: result, rejection } = reviewProposalWithReason(proposal([]), buildCorrectionInput(finding("DUP-01"), VAT_DEBIT_TWICE));
    assertRejected(result, /extourne chiffrée est exigée pour ce doublon/);
    assert.match(rejection, /crédit de 200\.00 MAD sur le compte 345520/);
  });

  it("keeps the reversal of the doubled VAT debit", () => {
    assert.equal(review([line("345520", 0, 200)], dup01(VAT_DEBIT_TWICE)).journalEntry.length, 1);
  });

  it("rejects a reversal on the wrong side or for the wrong amount", () => {
    assertRejected(review([line("441100", 0, 1200)], dup01(SUPPLIER_CREDIT_TWICE)), /n’extourne pas exactement/);
    assertRejected(review([line("441100", 2400, 0)], dup01(SUPPLIER_CREDIT_TWICE)), /n’extourne pas exactement/);
  });

  it("reverses every occurrence after the first when a line was recorded three times", () => {
    const thrice = [...SUPPLIER_CREDIT_TWICE, dupRow("2026-03-03", "441100", 0, 1200)];
    const input = buildCorrectionInput(finding("DUP-01"), thrice);
    assert.equal(input.duplicateReversal.reversalAmount, 2400);
    assert.equal(reviewProposal(proposal([line("441100", 2400, 0)]), input).journalEntry.length, 1);
  });

  it("refuses any figured entry when the rows are not one clear duplicate group", () => {
    const mixed = [SUPPLIER_CREDIT_TWICE[0], dupRow("2026-03-02", "441100", 0, 1000)];
    const truncated = Array.from({ length: 50 }, () => SUPPLIER_CREDIT_TWICE[0]);
    for (const rows of [mixed, truncated, [SUPPLIER_CREDIT_TWICE[0]]]) {
      const input = buildCorrectionInput(finding("DUP-01"), rows);
      assert.equal(input.correctionMode, "no_entry");
      assertRejected(reviewProposal(proposal([line("441100", 1200, 0)]), input), /ne se corrige pas par une écriture automatique/);
    }
  });
});

describe("reviewProposal on other findings", () => {
  it("rejects any entry proposed for BAL-01", () => {
    assertRejected(review([line("4411", 0, 200)], { ruleCode: "BAL-01" }), /ne se corrige pas par une écriture automatique/);
  });

  it("keeps a balanced entry for a balanced_entry finding", () => {
    const result = review([line("4411", 1000, 0), line("6111", 0, 1000)], { ruleCode: "REG-01" });
    assert.equal(result.journalEntry.length, 2);
    assert.equal(result.confidence, "moyenne");
  });

  it("rejects an unbalanced entry for a balanced_entry finding", () => {
    assertRejected(review([line("4411", 0, 200)], { ruleCode: "REG-01" }), /n’est pas équilibrée/);
  });

  it("keeps the rejection reason visible even when the model already filled 8 prerequisites", () => {
    const input = buildCorrectionInput(finding("BAL-01"), FA102_ROWS);
    const full = { ...proposal([line("4411", 0, 200)]), prerequisites: Array.from({ length: 8 }, (_, i) => `Point ${i + 1}`) };
    const result = reviewProposal(full, input);
    assert.equal(result.prerequisites.length, 8);
    assert.match(lastPrerequisite(result), /ne se corrige pas/);
  });
});
