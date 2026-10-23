/**
 * The hybrid audit scenario shared by the offline, database and live suites: one synthetic
 * journal, and the steps the web app runs on it, using the web app's own modules
 * (Level 1 engine, Level 2 batching, decision encoding). No real client data.
 */
import { randomUUID } from "node:crypto";
import { runAudit } from "../../audit-maroc/src/lib/audit-engine.ts";
import {
  buildSemanticBatches,
  semanticCellReference,
  semanticFinding,
  semanticItemFromConstat,
  semanticRowPayload,
} from "../../audit-maroc/src/lib/semantic.ts";

export { buildSemanticBatches, semanticFinding, semanticItemFromConstat, semanticRowPayload };

export const SOURCE_FILE = "journal-fictif-hybride.csv";
export const HEADERS = ["Date", "Journal", "Compte", "Libellé compte", "Pièce", "Libellé", "Débit", "Crédit"];
export const MAPPING = { date: "0", journal: "1", accountCode: "2", accountLabel: "3", reference: "4", description: "5", debit: "6", credit: "7" };

/**
 * Level 1 sees: FAC-304 and FAC-305 unbalanced (ECR-01), the doubled supplier credit (DUP-01),
 * hence an unbalanced file (BAL-01). Level 2 sees what arithmetic cannot: a restaurant bill as
 * goods purchases (IA-LIB-01) with recovered VAT (IA-TVA-01), and a computer expensed (IA-IMM-01).
 */
export const RAW_ROWS = [
  ["2026-03-04", "ACH", "6111", "Achats de marchandises", "FAC-301", "Restaurant La Sqala - déjeuner clients", "1000", "0"],
  ["2026-03-04", "ACH", "345520", "TVA récupérable sur charges", "FAC-301", "TVA restaurant", "100", "0"],
  ["2026-03-04", "ACH", "441100", "Fournisseurs", "FAC-301", "Restaurant La Sqala", "0", "1100"],
  ["2026-05-10", "ACH", "6125", "Achats non stockés", "FAC-303", "Ordinateur portable Dell Latitude", "14000", "0"],
  ["2026-05-10", "ACH", "441100", "Fournisseurs", "FAC-303", "Dell Maroc", "0", "14000"],
  ["2026-06-01", "ACH", "6142", "Transports", "FAC-304", "Transport marchandises Casablanca-Tanger", "2000", "0"],
  ["2026-06-01", "ACH", "441100", "Fournisseurs", "FAC-304", "CTM Messagerie", "0", "1800"],
  ["2026-07-02", "ACH", "441100", "Fournisseurs", "FAC-305", "Fournisseur Z", "0", "1200"],
  ["2026-07-02", "ACH", "441100", "Fournisseurs", "FAC-305", "Fournisseur Z", "0", "1200"],
  ["2026-07-02", "ACH", "6111", "Achats de marchandises", "FAC-305", "Marchandises Fournisseur Z", "1200", "0"],
];
export const EXPECTED_LEVEL1 = ["BAL-01", "DUP-01", "ECR-01", "ECR-01"];
/** Row index → Level 2 code a competent reviewer (and the fake Groq) flags. */
export const EXPECTED_LEVEL2 = { 0: "IA-LIB-01", 1: "IA-TVA-01", 3: "IA-IMM-01" };

/** Ledger entries as the web app builds them on import; `idPrefix` keeps runs apart in a shared database. */
export function buildEntries(idPrefix = "hybrid") {
  return RAW_ROWS.map((row, index) => ({
    id: `${idPrefix}-${randomUUID()}`,
    date: row[0], journal: row[1], accountCode: row[2], accountLabel: row[3], reference: row[4], description: row[5],
    debit: Number(row[6]), credit: Number(row[7]), amountParseError: false,
    sourceFile: SOURCE_FILE, sourceRow: index + 2,
  }));
}

export function datasetPayload(entries) {
  return { type: "CSV", documentType: "journal", period: "2026", entries, importedAt: new Date().toISOString(), headers: HEADERS, sourceRows: RAW_ROWS, mapping: MAPPING };
}

/** Level 1, exactly as the web app runs it after an import. */
export function runLevel1(entries) {
  return runAudit(entries, { documentType: "journal", fiscalYear: 2026, vatRates: [], vatCollectedPrefixes: [], vatRecoverablePrefixes: [] }, {});
}

/** Request bodies for Level 2, one per batch. */
export function semanticRequests(entries, maxRows) {
  const batches = buildSemanticBatches(entries, entries.map((_, index) => index), maxRows);
  return batches.map((batch) => ({ batch, body: { fiscalYear: 2026, rows: batch.map((index) => semanticRowPayload(entries[index], index)) } }));
}

/** The constat the web app saves for a finding (Level 1) or a Level 2 decision. */
export function constatPayload(finding, entries, decision) {
  const rows = entries.filter((entry) => finding.sourceRowIds.includes(entry.id));
  return {
    id: finding.id, ruleCode: finding.ruleCode, severity: finding.severity, amount: finding.amount,
    explanation: `${finding.title} — ${finding.explanation}`,
    cellReference: decision ? semanticCellReference(decision, finding.confidence, rows) : rows.map((row) => `Ligne ${row.sourceRow}`).join(" ; "),
    status: decision === "rejected" ? "ECARTE" : "A_EXAMINER",
    proposedCorrection: null,
  };
}

/** The finding and source rows the "Générer la correction IA" button sends. */
export function correctionRequest(finding, entries) {
  return {
    finding: { ruleCode: finding.ruleCode, severity: finding.severity, title: finding.title, explanation: finding.explanation, amount: finding.amount, suggestion: finding.suggestion },
    sourceRows: entries.filter((entry) => finding.sourceRowIds.includes(entry.id))
      .map(({ date, accountCode, accountLabel, reference, description, debit, credit }) => ({ date, accountCode, accountLabel, reference, description, debit, credit })),
  };
}

/** The aggregated digest the "revue agrégée" button sends (Level 1 only). */
export function reviewRequest(entries, level1) {
  const groups = new Map();
  for (const item of level1) {
    const key = `${item.ruleCode}-${item.severity}`;
    const current = groups.get(key) || { ruleCode: item.ruleCode, severity: item.severity, occurrences: 0 };
    current.occurrences += 1;
    groups.set(key, current);
  }
  const totalDebit = entries.reduce((sum, entry) => sum + entry.debit, 0);
  const totalCredit = entries.reduce((sum, entry) => sum + entry.credit, 0);
  return { fiscalYear: 2026, summary: { entryCount: entries.length, totalDebit, totalCredit, balanceDifference: totalDebit - totalCredit, findingsCount: level1.length }, findings: [...groups.values()] };
}
