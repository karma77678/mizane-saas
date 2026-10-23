// Pure helpers for the AI correction route: no database or network access, so they can be tested on their own.

export const correctionSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    journalEntry: {
      type: "array",
      items: {
        type: "object",
        properties: {
          accountCode: { type: "string" },
          accountLabel: { type: "string" },
          debit: { type: "number" },
          credit: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["accountCode", "accountLabel", "debit", "credit", "rationale"],
        additionalProperties: false,
      },
    },
    prerequisites: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["faible", "moyenne", "élevée"] },
    disclaimer: { type: "string" },
  },
  required: ["description", "journalEntry", "prerequisites", "confidence", "disclaimer"],
  additionalProperties: false,
} as const;

export const CORRECTION_SYSTEM_PROMPT = "Tu es un assistant d'audit comptable marocain. Propose une écriture de régularisation uniquement comme brouillon à faire vérifier. Ne certifie jamais la conformité et n'invente pas de données manquantes, de textes légaux ou de pièces. Sauf en modes vat_adjustment et reverse_duplicate, si les données sont insuffisantes, explique-le dans prerequisites et utilise un journalEntry vide plutôt que d'inventer une écriture chiffrée. Ne dis jamais qu'une correction a été appliquée.\n\nPlan comptable : utilise exclusivement le Code général de normalisation comptable marocain (CGNC), avec des numéros de comptes des classes 1 à 8 et leurs intitulés CGNC (par exemple 4411 Fournisseurs, 3421 Clients, 34552 État - TVA récupérable sur charges, 4455 État - TVA facturée, 5141 Banques, 5161 Caisse). N'utilise jamais de numéros du plan comptable français (par exemple 401, 411, 44566, 44571, 512, 530). Privilégie les comptes déjà présents dans sourceRows.\n\nRespecte correctionMode :\n- complete_document : la pièce source est déséquilibrée ; sourceDifference vaut total débit moins total crédit des sourceRows. Propose uniquement la ou les lignes manquantes qui complètent la pièce, de sorte que les sourceRows et tes lignes réunies soient équilibrées (tes lignes ne sont donc pas équilibrées entre elles). Identifie la contrepartie manquante d'après la logique de la pièce, par exemple la dette fournisseur TTC lorsque la charge HT et la TVA récupérable sont au débit.\n- balanced_entry : le total des débits proposés doit être égal au total des crédits proposés.\n- no_entry : journalEntry doit être vide ; décris les vérifications à mener dans prerequisites.\n- vat_adjustment : erreur de taux de TVA récupérable dont l'écart a été recalculé par le serveur dans vatAdjustment (chargeBase = base HT des charges, recordedVat = TVA enregistrée, expectedRate = taux attendu en %, expectedVat = base × taux attendu, excess = recordedVat − expectedVat). Une écriture de régularisation chiffrée et équilibrée est obligatoire ; un journalEntry vide ou de simples conseils seront refusés. Si excess est positif, crédite le compte de TVA récupérable de vatAdjustment.vatAccounts (numéro exact, tel qu'écrit dans sourceRows) pour exactement excess afin de contre-passer l'excédent, et débite la contrepartie du même montant ; si excess est négatif, débite ce compte de TVA de la valeur absolue de excess et crédite la contrepartie. La contrepartie par défaut est la dette fournisseur : utilise le compte fournisseur tel qu'il figure dans sourceRows (y compris un compte auxiliaire), ou 4411 Fournisseurs seulement s'il n'y figure pas, car l'excédent de TVA saisi a gonflé le montant TTC dû ; si la TVA excédentaire est en réalité non récupérable, la contrepartie est le compte de charge de sourceRows. Le calcul étant établi, indique une confiance « moyenne » ou « élevée », et liste dans prerequisites les vérifications sur la facture (taux légal applicable, montant TTC réellement dû, compte fournisseur auxiliaire).\n- reverse_duplicate : doublon de comptabilisation ; sourceRows sont des lignes identiques (même compte, même pièce, même montant) et duplicateReversal décrit la correction (account, duplicatedSide, lineAmount, occurrences, reversalAmount). Un doublon se corrige en EXTOURNANT (contre-passant) la ou les lignes en trop, jamais en ajoutant des charges, des produits ou une autre contrepartie, ce qui aggraverait le doublon. Propose uniquement des lignes sur duplicateReversal.account (numéro exact) : si duplicatedSide vaut credit, un débit de reversalAmount ; si duplicatedSide vaut debit, un crédit de reversalAmount. Cette extourne n'est pas équilibrée à elle seule : si la pièce entière a été saisie deux fois, ses autres lignes en double font l'objet de leurs propres constats et sont extournées séparément. Une écriture vide ou de simples conseils seront refusés. Indique une confiance « moyenne » ou « élevée », et liste dans prerequisites les vérifications : comparer les pièces originales, identifier laquelle des lignes est en trop, vérifier qu'il ne s'agit pas de deux opérations réelles distinctes.\nDébits et crédits non négatifs, une seule colonne renseignée par ligne, et ne débite ni ne crédite jamais le même compte dans une même proposition.";

// A balanced entry cannot fix an unbalanced document: for ECR-01 the proposal completes the
// document, so source rows + proposed lines must balance, not the proposed lines alone.
const DOCUMENT_COMPLETION_RULES = new Set(["ECR-01"]);
// BAL-01 covers a whole, possibly partial, import: the audit engine forbids an automatic entry.
const NO_ENTRY_RULES = new Set(["BAL-01"]);
// CGNC entries post to numeric accounts of at least 4 digits, classes 1 to 8 (class 0 holds
// off-balance-sheet commitments). This also rejects short French codes such as 401, 411 or 512.
const CGNC_ACCOUNT = /^[1-8]\d{3,9}$/;
export const MAX_SOURCE_ROWS = 50;
// FISC-03 flags a recoverable-VAT rate inconsistency: the gap is plain arithmetic, so a figured entry is required.
const VAT_RATE_RULES = new Set(["FISC-03"]);
// Same inputs as the audit engine's FISC-03 check (audit-maroc/src/lib/audit-engine.ts).
const RECOVERABLE_VAT_PREFIX = "3455";
export const MOROCCAN_VAT_RATES = [20, 14, 10, 7];
const VAT_RATE_GAP_POINTS = 2;

// DUP-01 groups identical lines (same account, reference, debit and credit): the fix reverses the extra
// line(s) on that account. Their counterparts, when the whole document was entered twice, are themselves
// duplicated lines with their own DUP-01 findings, so each finding reverses only its own account.
const DUPLICATE_RULES = new Set(["DUP-01"]);

export type CorrectionMode = "complete_document" | "balanced_entry" | "no_entry" | "vat_adjustment" | "reverse_duplicate";
export type DuplicateReversal = {
  account: string;
  duplicatedSide: "debit" | "credit";
  lineAmount: number;
  occurrences: number;
  reversalAmount: number;
};
export type CorrectionInput = ReturnType<typeof buildCorrectionInput>;
export type VatAdjustment = {
  vatAccounts: string[];
  chargeBase: number;
  recordedVat: number;
  observedRate: number;
  expectedRate: number;
  expectedVat: number;
  excess: number;
};

const cleanText = (value: unknown, max = 2000) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").slice(0, max) : "";
const cleanAmount = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round2 = (value: number) => Math.round(value * 100) / 100;
const accountDigits = (accountCode: string) => accountCode.replace(/\D/g, "");

// Derives the DUP-01 reversal from the source rows: every occurrence after the first is reversed. Returns
// null when the rows are not one group of identical single-sided lines, or when the group may be truncated.
export function computeDuplicateReversal(
  sourceRows: { accountCode: string; debit: number; credit: number }[],
): DuplicateReversal | null {
  if (sourceRows.length < 2 || sourceRows.length >= MAX_SOURCE_ROWS) return null;
  const [first] = sourceRows;
  const account = first.accountCode.trim();
  const identical = sourceRows.every((row) =>
    row.accountCode.trim().toLowerCase() === account.toLowerCase() && row.debit === first.debit && row.credit === first.credit);
  const singleSided = (first.debit > 0) !== (first.credit > 0) && first.debit >= 0 && first.credit >= 0;
  if (!account || !identical || !singleSided) return null;
  const lineAmount = round2(first.debit || first.credit);
  return {
    account,
    duplicatedSide: first.credit > 0 ? "credit" : "debit",
    lineAmount,
    occurrences: sourceRows.length,
    reversalAmount: round2(lineAmount * (sourceRows.length - 1)),
  };
}

// Recomputes the FISC-03 gap from the source rows. Returns null when the gap is not evident: no charge
// base or VAT, a possibly truncated document, a gap within tolerance, or a finding amount that disagrees
// (the cabinet configured other reference rates than the Moroccan ones).
export function computeVatAdjustment(
  sourceRows: { accountCode: string; debit: number; credit: number }[],
  findingAmount: number,
): VatAdjustment | null {
  if (sourceRows.length >= MAX_SOURCE_ROWS) return null;
  const chargeRows = sourceRows.filter((row) => accountDigits(row.accountCode).startsWith("6") && row.debit > row.credit);
  const vatRows = sourceRows.filter((row) => accountDigits(row.accountCode).startsWith(RECOVERABLE_VAT_PREFIX));
  const chargeBase = chargeRows.reduce((sum, row) => sum + Math.max(0, row.debit - row.credit), 0);
  const recordedVat = vatRows.reduce((sum, row) => sum + Math.max(0, row.debit - row.credit), 0);
  if (chargeBase <= 0.01 || recordedVat <= 0.01) return null;
  const observedRate = (recordedVat / chargeBase) * 100;
  const expectedRate = MOROCCAN_VAT_RATES.reduce((closest, rate) =>
    Math.abs(rate - observedRate) < Math.abs(closest - observedRate) ? rate : closest);
  if (Math.abs(observedRate - expectedRate) <= VAT_RATE_GAP_POINTS) return null;
  const expectedVat = round2(chargeBase * expectedRate / 100);
  const excess = round2(recordedVat - expectedVat);
  if (Math.abs(excess) <= 0.01) return null;
  // The engine stores the finding amount as an absolute value: compare magnitudes.
  if (findingAmount !== 0 && Math.abs(Math.abs(findingAmount) - Math.abs(excess)) > 0.02) return null;
  return {
    vatAccounts: [...new Set(vatRows.map((row) => row.accountCode.trim()))],
    chargeBase: round2(chargeBase),
    recordedVat: round2(recordedVat),
    observedRate: round2(observedRate),
    expectedRate,
    expectedVat,
    excess,
  };
}

export function buildCorrectionInput(finding: Record<string, unknown>, rows: any[]) {
  const ruleCode = cleanText(finding.ruleCode, 80);
  const sourceRows = rows.map((row: any) => ({
    date: cleanText(row?.date, 50),
    accountCode: cleanText(row?.accountCode, 60),
    accountLabel: cleanText(row?.accountLabel, 180),
    reference: cleanText(row?.reference, 160),
    description: cleanText(row?.description, 500),
    debit: cleanAmount(row?.debit),
    credit: cleanAmount(row?.credit),
  }));
  const sourceDifference = Math.round(sourceRows.reduce((sum, row) => sum + row.debit - row.credit, 0) * 100) / 100;
  let correctionMode: CorrectionMode = "balanced_entry";
  if (NO_ENTRY_RULES.has(ruleCode)) correctionMode = "no_entry";
  else if (DOCUMENT_COMPLETION_RULES.has(ruleCode)) {
    // The client truncates at 50 rows: the document may then be incomplete, so its gap cannot be trusted.
    correctionMode = sourceRows.length < MAX_SOURCE_ROWS && Math.abs(sourceDifference) > 0.01 ? "complete_document" : "no_entry";
  }
  // When the gap is not evident, FISC-03 keeps the general balanced_entry mode.
  const vatAdjustment = VAT_RATE_RULES.has(ruleCode) ? computeVatAdjustment(sourceRows, cleanAmount(finding.amount)) : null;
  if (vatAdjustment) correctionMode = "vat_adjustment";
  // A balanced entry would make the model invent a counterpart and worsen the duplicate: without a
  // clear group to reverse, DUP-01 gets no figured entry at all.
  const duplicateReversal = DUPLICATE_RULES.has(ruleCode) ? computeDuplicateReversal(sourceRows) : null;
  if (DUPLICATE_RULES.has(ruleCode)) correctionMode = duplicateReversal ? "reverse_duplicate" : "no_entry";
  return {
    correctionMode,
    sourceDifference,
    vatAdjustment,
    duplicateReversal,
    ruleCode,
    severity: cleanText(finding.severity, 20),
    title: cleanText(finding.title, 300),
    explanation: cleanText(finding.explanation, 3000),
    amount: cleanAmount(finding.amount),
    suggestion: cleanText(finding.suggestion, 3000),
    sourceRows,
  };
}

// True when a text-only answer is not acceptable and the route should ask the model once more.
export const entryIsRequired = (input: CorrectionInput) =>
  input.correctionMode === "vat_adjustment" || input.correctionMode === "reverse_duplicate";

export function reviewProposal(proposal: Record<string, unknown>, input: CorrectionInput): Record<string, unknown> {
  return reviewProposalWithReason(proposal, input).proposal;
}

// Never display an invalid generated journal entry as a usable draft: on any failed check the
// lines are dropped, confidence is lowered and the reason is added to the prerequisites and returned.
export function reviewProposalWithReason(proposal: Record<string, unknown>, input: CorrectionInput): { proposal: Record<string, unknown>; rejection: string } {
  const { correctionMode, sourceDifference } = input;
  // Array size limits are enforced here rather than in the schema sent to Groq.
  const prerequisites = Array.isArray(proposal.prerequisites)
    ? proposal.prerequisites.filter((item): item is string => typeof item === "string").slice(0, 8)
    : [];
  proposal.prerequisites = prerequisites;
  const rawLines = Array.isArray(proposal.journalEntry) ? proposal.journalEntry : [];
  const journalLines = rawLines.filter((line): line is Record<string, unknown> =>
    Boolean(line) && typeof line === "object" && !Array.isArray(line),
  );
  const valuesAreValid = rawLines.length <= 8 && journalLines.length === rawLines.length && journalLines.every((line) =>
    typeof line.debit === "number" && Number.isFinite(line.debit) && line.debit >= 0 &&
    typeof line.credit === "number" && Number.isFinite(line.credit) && line.credit >= 0 &&
    !(line.debit > 0 && line.credit > 0),
  );
  const accountOf = (line: Record<string, unknown>) => typeof line.accountCode === "string" ? line.accountCode.trim() : "";
  const sourceAccounts = new Set(input.sourceRows.map((row) => row.accountCode.trim()));
  // Codes taken from the source rows are trusted as the file's own chart of accounts (auxiliary codes included).
  const accountsAreCgnc = journalLines.every((line) => sourceAccounts.has(accountOf(line)) || CGNC_ACCOUNT.test(accountOf(line)));
  const totalDebit = valuesAreValid ? journalLines.reduce((sum, line) => sum + Number(line.debit), 0) : 0;
  const totalCredit = valuesAreValid ? journalLines.reduce((sum, line) => sum + Number(line.credit), 0) : 0;
  // A duplicate reversal is one-sided by nature; its amount is checked against duplicateReversal instead.
  const balanced = journalLines.length === 0 || correctionMode === "reverse_duplicate" || (correctionMode === "complete_document"
    ? Math.abs(sourceDifference + totalDebit - totalCredit) <= 0.01
    : Math.abs(totalDebit - totalCredit) <= 0.01);
  // Debiting and crediting the same account cancels out: the entry would look balanced but correct nothing.
  const debitedAccounts = new Set<string>();
  const creditedAccounts = new Set<string>();
  for (const line of journalLines) {
    if (Number(line.debit) > 0) debitedAccounts.add(accountOf(line));
    if (Number(line.credit) > 0) creditedAccounts.add(accountOf(line));
  }
  const sameAccountBothSides = [...debitedAccounts].some((account) => creditedAccounts.has(account));
  // For an evident VAT rate error, the entry must move the VAT account(s) by exactly the recomputed excess.
  const vat = correctionMode === "vat_adjustment" ? input.vatAdjustment : null;
  const vatAccounts = new Set(vat?.vatAccounts ?? []);
  const vatMovement = journalLines.reduce((sum, line) =>
    vatAccounts.has(accountOf(line)) ? sum + Number(line.debit) - Number(line.credit) : sum, 0);
  const vatTarget = vat
    ? `${vat.excess > 0 ? "crédit" : "débit"} de ${Math.abs(vat.excess).toFixed(2)} MAD sur le compte ${vat.vatAccounts.join(" / ")} (TVA enregistrée ${vat.recordedVat.toFixed(2)} MAD, attendue ${vat.expectedVat.toFixed(2)} MAD à ${vat.expectedRate} %)`
    : "";
  // For a duplicate, the entry must reverse exactly the extra occurrence(s), on the duplicated account only.
  const dup = correctionMode === "reverse_duplicate" ? input.duplicateReversal : null;
  const onDuplicatedAccount = (line: Record<string, unknown>) => accountOf(line).toLowerCase() === dup?.account.toLowerCase();
  const otherAccounts = dup ? [...new Set(journalLines.filter((line) => !onDuplicatedAccount(line)).map(accountOf))] : [];
  const dupMovement = journalLines.reduce((sum, line) =>
    onDuplicatedAccount(line) ? sum + Number(line.debit) - Number(line.credit) : sum, 0);
  const dupExpectedMovement = dup ? (dup.duplicatedSide === "credit" ? dup.reversalAmount : -dup.reversalAmount) : 0;
  const dupTarget = dup
    ? `${dup.duplicatedSide === "credit" ? "débit" : "crédit"} de ${dup.reversalAmount.toFixed(2)} MAD sur le compte ${dup.account} (extourne de ${dup.occurrences - 1} ligne(s) en trop sur ${dup.occurrences} lignes identiques de ${dup.lineAmount.toFixed(2)} MAD au ${dup.duplicatedSide === "credit" ? "crédit" : "débit"})`
    : "";

  let rejection = "";
  if (correctionMode === "no_entry" && journalLines.length > 0) rejection = "Ce type de constat ne se corrige pas par une écriture automatique : vérifiez d’abord le périmètre importé et les pièces complètes ; aucune écriture n’est proposée.";
  else if (vat && journalLines.length === 0) rejection = `Une écriture de régularisation chiffrée est exigée pour cette erreur de taux de TVA, mais l’IA n’en a fourni aucune. Correction attendue : ${vatTarget}, avec sa contrepartie.`;
  else if (dup && journalLines.length === 0) rejection = `Une écriture d’extourne chiffrée est exigée pour ce doublon, mais l’IA n’en a fourni aucune. Correction attendue : ${dupTarget}.`;
  else if (!valuesAreValid) rejection = "L’écriture générée contenait des montants invalides ; aucune écriture n’est proposée. Faites vérifier les pièces et les soldes par un professionnel.";
  else if (!accountsAreCgnc) rejection = "L’écriture générée utilisait des numéros de comptes hors du plan comptable marocain (CGNC) ; aucune écriture n’est proposée. Faites vérifier les comptes par un professionnel.";
  else if (sameAccountBothSides) rejection = "L’écriture générée débitait et créditait le même compte, ce qui n’aurait rien corrigé ; aucune écriture n’est proposée. Faites vérifier les pièces et les soldes par un professionnel.";
  else if (!balanced) rejection = correctionMode === "complete_document"
    ? `Les lignes générées ne rééquilibrent pas la pièce (écart source de ${Math.abs(sourceDifference).toFixed(2)} MAD) ; aucune écriture n’est proposée. Faites vérifier la pièce justificative par un professionnel.`
    : "L’écriture générée n’est pas équilibrée ; aucune écriture n’est proposée. Faites vérifier les pièces et les soldes par un professionnel.";
  else if (vat && Math.abs(vatMovement + vat.excess) > 0.01) rejection = `L’écriture générée ne régularise pas exactement l’écart de TVA ; aucune écriture n’est proposée. Correction attendue : ${vatTarget}, avec sa contrepartie.`;
  else if (dup && otherAccounts.length) rejection = `L’écriture générée ajoutait des lignes sur d’autres comptes (${otherAccounts.join(", ")}) au lieu d’extourner la ligne en double, ce qui aggraverait le doublon ; aucune écriture n’est proposée. Correction attendue : ${dupTarget}.`;
  else if (dup && Math.abs(dupMovement - dupExpectedMovement) > 0.01) rejection = `L’écriture générée n’extourne pas exactement la ou les lignes en double ; aucune écriture n’est proposée. Correction attendue : ${dupTarget}.`;

  if (rejection) {
    proposal.journalEntry = [];
    proposal.confidence = "faible";
    proposal.prerequisites = [...prerequisites.slice(0, 7), rejection];
    proposal.disclaimer = typeof proposal.disclaimer === "string" ? proposal.disclaimer : "Proposition indicative à faire vérifier.";
    return { proposal, rejection };
  }
  // The amounts were checked against the server's own computation: the figures are not a guess.
  if ((vat || dup) && proposal.confidence !== "élevée") proposal.confidence = "moyenne";
  const warnings: string[] = [];
  const newAccounts = [...new Set(journalLines.map(accountOf).filter((account) => !sourceAccounts.has(account)))];
  if (newAccounts.length) {
    // An account the document never used is the model's own choice: never present it as highly reliable.
    if (proposal.confidence === "élevée") proposal.confidence = "moyenne";
    warnings.push(`Compte(s) absent(s) des lignes sources : ${newAccounts.join(", ")}. Vérifiez leur existence dans le plan de comptes du dossier (CGNC).`);
  }
  // Rebalancing a document by reversing one of its own lines is legitimate only if that source amount is wrong.
  if (correctionMode === "complete_document") {
    const reversed = journalLines.map(accountOf).filter((account, index) => input.sourceRows.some((row) =>
      row.accountCode.trim() === account &&
      ((row.debit > 0 && Number(journalLines[index].credit) > 0) || (row.credit > 0 && Number(journalLines[index].debit) > 0))));
    if (reversed.length) {
      proposal.confidence = "faible";
      warnings.push(`La proposition contrepasse en partie la ou les lignes sources du compte ${[...new Set(reversed)].join(", ")} au lieu d’ajouter la contrepartie manquante. Ne la retenez que si la pièce justificative confirme que ce montant source est erroné.`);
    }
  }
  if (warnings.length) proposal.prerequisites = [...prerequisites.slice(0, 8 - warnings.length), ...warnings];
  return { proposal, rejection: "" };
}
