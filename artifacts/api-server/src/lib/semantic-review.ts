// Level 2 of the audit: a semantic reading of ledger rows by the model.
// It reads every row on its own, without knowing what Level 1 (the deterministic engine in the
// web app) already flagged, so the auditor can compare both restitutions side by side; the
// browser merges an accepted prediction into the matching Level 1 constat. Every prediction is
// checked here against the rows actually sent before it reaches the auditor.

/** Rows per model call, sized so prompt + rows + answer stay under the free plan's 8K tokens per minute. */
export const MAX_SEMANTIC_ROWS = 50;
export const MAX_SEMANTIC_FINDINGS = 12;
const MAX_ROWS_PER_FINDING = 20;
/** Purchases above this amount booked in class 6 are read as possible fixed assets (IA-IMM-01). */
export const ASSET_THRESHOLD_MAD = 5000;
/** Fuzzy duplicates: amounts within this relative gap and dates within this many days. */
const DUPLICATE_AMOUNT_GAP = 0.02;
const DUPLICATE_WINDOW_DAYS = 5;
const MAX_DUPLICATE_LEADS = 25;

/** Closed list: the model may only use these codes, and the title shown is always ours. */
export const SEMANTIC_RULES: Record<string, string> = {
  "IA-DUP-01": "Doublon probable (pièce ou libellé quasi identique)",
  "IA-LIB-01": "Libellé incohérent avec le compte imputé",
  "IA-IMM-01": "Immobilisation comptabilisée en charge : reclassement à proposer",
  "IA-TVA-01": "TVA incohérente ou à droit à déduction exclu ou limité",
  "IA-DED-01": "Charge non déductible ou à déductibilité fiscale à vérifier",
  "IA-PER-01": "Rattachement à l’exercice (cut-off) à vérifier d’après le libellé",
  "IA-TIE-01": "Compte de tiers incohérent avec l’opération décrite",
  "IA-AUT-01": "Autre anomalie sémantique à examiner",
};
export const SEMANTIC_CODES = Object.keys(SEMANTIC_RULES);
const SEVERITIES = ["high", "medium", "low", "info"] as const;
const CONFIDENCES = ["faible", "moyenne", "élevée"] as const;

export type SemanticRow = {
  index: number;
  date: string;
  accountCode: string;
  accountLabel: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
};

export type SemanticFinding = {
  code: string;
  title: string;
  severity: (typeof SEVERITIES)[number];
  confidence: (typeof CONFIDENCES)[number];
  explanation: string;
  rowIndices: number[];
  amount: number;
};

export const semanticSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "coverageNote"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "severity", "confidence", "explanation", "rowIndices"],
        properties: {
          code: { type: "string", enum: SEMANTIC_CODES },
          severity: { type: "string", enum: [...SEVERITIES] },
          confidence: { type: "string", enum: [...CONFIDENCES] },
          explanation: { type: "string" },
          rowIndices: { type: "array", items: { type: "integer" } },
        },
      },
    },
    coverageNote: { type: "string" },
  },
} as const;

export const SEMANTIC_SYSTEM_PROMPT = `Tu es un réviseur comptable marocain (Plan Comptable Général des Entreprises, CGNC, et Code Général des Impôts).
Tu reçois un lot de lignes d'écritures : index, date, compte, libellé du compte, pièce, libellé de l'écriture, débit, crédit (MAD), l'exercice audité et des pistes de doublons pré-calculées (pistesDoublons : paires d'index).
Tu fais une lecture SÉMANTIQUE complète et autonome du lot : examine CHAQUE ligne, y compris celles qu'un contrôle arithmétique aurait déjà pu relever (doublons, pénalités, TVA, dates). Ton analyse est comparée côte à côte avec celle du moteur déterministe : ne suppose jamais qu'une anomalie est déjà traitée ailleurs.

Codes autorisés (n'en invente aucun) :
- IA-DUP-01 : doublon flou ou sémantique. Rapproche les écritures de montant identique ou très proche (écart ≤ 2 %) dont les dates sont séparées de ${DUPLICATE_WINDOW_DAYS} jours au plus. Indices : même numéro de pièce, numéro avec variation ou suffixe (« -BIS », « -DUP », « -2 », « v2 », « copie », lettre ajoutée), ou libellés de même sens malgré des mots différents (« Maintenance climatisation siège » / « Maintenance clim bureau principal »). Cite les lignes des deux écritures. Confirme une piste de pistesDoublons seulement si la pièce ou le libellé le justifie, et cherche aussi celles qu'elle ne contient pas.
- IA-IMM-01 : achat d'un bien durable ou d'un équipement (matériel informatique, serveur, ordinateur, véhicule, machine, mobilier, aménagement, agencement, installation, logiciel) de plus de ${ASSET_THRESHOLD_MAD} MAD (ou significatif pour le lot) imputé en charge de classe 6 (ex. 6111, 6125, 6131, 6133, 6134, 6141, 618…). Indique dans l'explication le compte d'immobilisation de classe 2 proposé (ex. 2355 matériel informatique, 2340 matériel de transport, 2351 mobilier de bureau, 2327 agencements et aménagements, 2332 matériel et outillage, 2220 logiciels). Signale aussi l'inverse (petite charge courante portée en classe 2).
- IA-PER-01 : rattachement à l'exercice (cut-off). Compare la date de la ligne et l'exercice audité avec toute mention de période dans le libellé (« exercice 2025 », « charge 2024 », « prest Q4 2025 », « loyer janvier 2027 », un mois ou un trimestre) ; signale toute écriture dont la période mentionnée relève d'un autre exercice que celui de sa date, en précisant s'il faut une charge constatée d'avance, une charge à payer ou un produit à recevoir.
- IA-DED-01 : charge non déductible ou à déductibilité douteuse : pénalités, amendes, majorations de retard, sanctions, dépenses personnelles du dirigeant, dons hors cas prévus, cadeaux, ou tout libellé indiquant une charge non déductible (à réintégrer au résultat fiscal).
- IA-TVA-01 : incohérence de TVA : taux mentionné dans le libellé (« TVA 20 % ») qui ne correspond pas au rapport entre la ligne de TVA et la base de la même pièce, taux inexistant au Maroc (taux légaux 20 %, 14 %, 10 %, 7 %), ou TVA portée en 3455 sur une dépense dont la déduction est exclue ou limitée (véhicules de tourisme, cadeaux, frais de réception ou de restaurant, dépenses personnelles).
- IA-LIB-01 : le libellé de l'écriture décrit une nature différente du compte imputé (ex. « loyer bureau » en 6111 achats de marchandises).
- IA-TIE-01 : compte de tiers incohérent avec l'opération (client 3421 sur une facture d'achat, fournisseur 4411 sur une vente, personnel 443 pour un tiers externe).
- IA-AUT-01 : autre anomalie sémantique nette, à n'utiliser qu'en dernier recours.

Règles strictes :
- Chaque constat doit citer dans rowIndices uniquement des index présents dans le lot, et son explication doit reprendre en français le mot, le libellé, le numéro de pièce ou le montant qui le justifie (ex. « la pièce “FAC-118-BIS” du 14/03 reprend les 12 400 MAD de “FAC-118” du 12/03 »).
- Une même ligne peut relever de plusieurs codes : signale chacun séparément (ex. une pénalité qui est aussi un doublon).
- Sans indice textuel ou chiffré précis dans les lignes, ne signale rien. Un lot sans anomalie renvoie findings = [].
- severity : high (impact fiscal ou comptable probable), medium (à vérifier), low ou info. confidence : faible, moyenne ou élevée selon la netteté de l'indice.
- Pas plus de ${MAX_SEMANTIC_FINDINGS} constats ; regroupe les lignes d'une même pièce dans un seul constat par code.
- coverageNote : une phrase sur ce que tu as pu ou non apprécier dans ce lot.
- Tu ne connais ni les pièces justificatives ni le contexte de l'entreprise : formule des hypothèses à vérifier, jamais des conclusions.`;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const cleanText = (value: unknown, max: number) => (typeof value === "string" ? value.replace(CONTROL_CHARS, " ").trim().slice(0, max) : "");
const cleanAmount = (value: unknown) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
};

/** Cleans the rows sent by the browser; returns null when the batch is not usable. */
export function sanitizeSemanticRows(raw: unknown): SemanticRow[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SEMANTIC_ROWS) return null;
  const seen = new Set<number>();
  const rows: SemanticRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    const index = Number(row.index);
    if (!Number.isInteger(index) || index < 0 || index > 1_000_000 || seen.has(index)) return null;
    seen.add(index);
    rows.push({
      index,
      date: cleanText(row.date, 30),
      accountCode: cleanText(row.accountCode, 30),
      accountLabel: cleanText(row.accountLabel, 120),
      reference: cleanText(row.reference, 60),
      description: cleanText(row.description, 160),
      debit: cleanAmount(row.debit),
      credit: cleanAmount(row.credit),
    });
  }
  return rows;
}

/** Day number of a "yyyy-mm-dd" or "dd/mm/yyyy" date (any of "-", "/", "."), or null. */
function dayNumber(value: string): number | null {
  const parts = value.match(/\d+/g);
  if (!parts || parts.length < 3) return null;
  const [year, month, day] = parts[0].length === 4 ? [parts[0], parts[1], parts[2]] : [parts[2], parts[1], parts[0]];
  const time = Date.UTC(Number(year.length === 2 ? `20${year}` : year), Number(month) - 1, Number(day));
  return Number.isFinite(time) ? Math.round(time / 86_400_000) : null;
}

/**
 * Candidate fuzzy duplicates inside the batch: same account and side, amounts within 2 %, dates at
 * most five days apart. They are hints for the model, never findings on their own.
 */
export function duplicateLeads(rows: SemanticRow[]): [number, number][] {
  const sided = rows
    .map((row) => ({ row, side: row.debit > 0 ? "D" : "C", amount: Math.max(row.debit, row.credit), day: dayNumber(row.date) }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => a.amount - b.amount);
  const leads: [number, number][] = [];
  for (let first = 0; first < sided.length && leads.length < MAX_DUPLICATE_LEADS; first += 1) {
    for (let second = first + 1; second < sided.length && leads.length < MAX_DUPLICATE_LEADS; second += 1) {
      const a = sided[first];
      const b = sided[second];
      if (b.amount - a.amount > a.amount * DUPLICATE_AMOUNT_GAP) break;
      if (a.side !== b.side || a.row.accountCode !== b.row.accountCode) continue;
      if (a.day !== null && b.day !== null && Math.abs(a.day - b.day) > DUPLICATE_WINDOW_DAYS) continue;
      leads.push([Math.min(a.row.index, b.row.index), Math.max(a.row.index, b.row.index)]);
    }
  }
  return leads;
}

/** Compact tabular form: column names once, then one array per row, to save tokens. */
export function buildSemanticInput(rows: SemanticRow[], fiscalYear: number | null) {
  return {
    fiscalYear,
    seuilImmobilisationMAD: ASSET_THRESHOLD_MAD,
    columns: ["index", "date", "compte", "libelleCompte", "piece", "libelle", "debit", "credit"],
    rows: rows.map((row) => [row.index, row.date, row.accountCode, row.accountLabel, row.reference, row.description, row.debit, row.credit]),
    pistesDoublons: duplicateLeads(rows),
  };
}

/**
 * Keeps only predictions the server can stand behind: known code, rows that were in the batch,
 * non-empty explanation. The title and the amount are computed here, never taken from the model.
 */
export function reviewSemanticAnswer(decoded: unknown, rows: SemanticRow[]): { findings: SemanticFinding[]; coverageNote: string; discarded: number } {
  const answer = decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : {};
  const rawFindings = Array.isArray(answer.findings) ? answer.findings : [];
  const byIndex = new Map(rows.map((row) => [row.index, row]));
  const seen = new Set<string>();
  const findings: SemanticFinding[] = [];
  let discarded = 0;
  for (const item of rawFindings) {
    const candidate = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const code = typeof candidate.code === "string" && Object.hasOwn(SEMANTIC_RULES, candidate.code) ? candidate.code : null;
    const severity = SEVERITIES.find((value) => value === candidate.severity);
    const confidence = CONFIDENCES.find((value) => value === candidate.confidence) ?? "faible";
    const explanation = cleanText(candidate.explanation, 700);
    const indices = Array.isArray(candidate.rowIndices)
      ? [...new Set(candidate.rowIndices.map(Number))].filter((index) => Number.isInteger(index) && byIndex.has(index)).sort((a, b) => a - b).slice(0, MAX_ROWS_PER_FINDING)
      : [];
    const key = `${code}|${indices.join(",")}`;
    if (!code || !severity || !explanation || !indices.length || seen.has(key) || findings.length >= MAX_SEMANTIC_FINDINGS) {
      discarded += 1;
      continue;
    }
    seen.add(key);
    const cited = indices.map((index) => byIndex.get(index)!);
    const debit = cited.reduce((sum, row) => sum + row.debit, 0);
    const credit = cited.reduce((sum, row) => sum + row.credit, 0);
    findings.push({ code, title: SEMANTIC_RULES[code], severity, confidence, explanation, rowIndices: indices, amount: cleanAmount(Math.max(debit, credit)) });
  }
  return { findings, coverageNote: cleanText(answer.coverageNote, 400), discarded };
}
