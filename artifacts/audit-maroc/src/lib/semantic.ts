import type { AuditFinding, LedgerEntry } from '@/hooks/use-audit';
import { findingId } from './audit-engine.ts';

/** Keep in step with MAX_SEMANTIC_ROWS in the API's semantic-review lib. */
export const SEMANTIC_BATCH_ROWS = 50;
/** Rows analysed per run: about four Groq calls, within the free plan's per-minute token budget. */
export const SEMANTIC_SCOPE_ROWS = 200;

export type SemanticConfidence = 'faible' | 'moyenne' | 'élevée';
export type SemanticDecision = 'pending' | 'merged' | 'rejected';
/** One finding as returned by POST /api/audit/semantic-review. */
export type SemanticPrediction = {
  code: string;
  title: string;
  severity: 'high' | 'medium' | 'low' | 'info';
  confidence: SemanticConfidence;
  explanation: string;
  rowIndices: number[];
  amount: number;
};
export type SemanticItem = {
  finding: AuditFinding;
  decision: SemanticDecision;
  datasetId: string;
  /** Set once accepted when the prediction was folded into this Level 1 constat instead of added. */
  mergedInto?: string;
};

export const SEMANTIC_SUGGESTION = 'Prédiction IA (Niveau 2) : rapprocher la pièce justificative et le libellé avant de retenir ce constat.';

/** Strips the usual copy markers from a document number: "FAC-118-BIS", "FAC-118 v2", "FAC-118 (copie)" → "fac118". */
export function referenceBase(reference: string): string {
  return reference
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s._/()-]*(bis|ter|dup|duplicata|doublon|copie|copy|v\d+)[\s)]*$/u, '')
    // "FAC-118-2" is a copy of "FAC-118", but "FAC-2" is its own document.
    .replace(/(\d)[\s._/-]+\d$/u, '$1')
    .replace(/[^a-z0-9]/g, '');
}

const DUPLICATE_WINDOW_DAYS = 5;
function dayNumber(value: string): number | null {
  const parts = value.match(/\d+/g);
  if (!parts || parts.length < 3) return null;
  const [year, month, day] = parts[0].length === 4 ? [parts[0], parts[1], parts[2]] : [parts[2], parts[1], parts[0]];
  const time = Date.UTC(Number(year.length === 2 ? `20${year}` : year), Number(month) - 1, Number(day));
  return Number.isFinite(time) ? Math.round(time / 86_400_000) : null;
}

/**
 * Splits the scope into batches of at most `maxRows` rows, keeping the rows of one document
 * (same reference) together so the model reads each document whole. Documents that may be
 * duplicates of one another (reference differing only by "-BIS", "v2"…, or the same amount on
 * the same account within five days) are also kept together while the batch size allows it,
 * since the model can only compare rows it sees in one call. Returns indices into `entries`.
 */
export function buildSemanticBatches(entries: LedgerEntry[], indices: number[], maxRows = SEMANTIC_BATCH_ROWS): number[][] {
  const documents = new Map<string, number[]>();
  for (const index of indices) {
    const reference = entries[index]?.reference.trim();
    const key = reference ? `ref:${reference}` : `row:${index}`;
    const group = documents.get(key);
    if (group) group.push(index);
    else documents.set(key, [index]);
  }
  // Union of documents into clusters of likely duplicates, bounded by the batch size.
  const keys = [...documents.keys()];
  const parent = keys.map((_, position) => position);
  const size = keys.map((key) => documents.get(key)!.length);
  const root = (position: number): number => parent[position] === position ? position : (parent[position] = root(parent[position]));
  const join = (a: number, b: number) => {
    const [first, second] = [root(a), root(b)].sort((x, y) => x - y);
    if (first === second || size[first] + size[second] > maxRows) return;
    parent[second] = first;
    size[first] += size[second];
  };
  const byBase = new Map<string, number>();
  const byAmount = new Map<string, { position: number; day: number | null }[]>();
  keys.forEach((key, position) => {
    const rows = documents.get(key)!.map((index) => entries[index]);
    const base = key.startsWith('ref:') ? referenceBase(key.slice(4)) : '';
    if (base) {
      const known = byBase.get(base);
      if (known === undefined) byBase.set(base, position);
      else join(known, position);
    }
    for (const row of rows) {
      const amount = Math.max(row.debit, row.credit);
      if (!(amount > 0)) continue;
      const amountKey = `${row.accountCode.trim()}|${row.debit > 0 ? 'D' : 'C'}|${amount.toFixed(2)}`;
      const day = dayNumber(row.date);
      const seen = byAmount.get(amountKey) || [];
      for (const other of seen) {
        if (other.day === null || day === null || Math.abs(other.day - day) <= DUPLICATE_WINDOW_DAYS) join(other.position, position);
      }
      if (seen.length < 8) seen.push({ position, day });
      byAmount.set(amountKey, seen);
    }
  });
  const clusters = new Map<number, number[]>();
  keys.forEach((key, position) => {
    const cluster = clusters.get(root(position));
    if (cluster) cluster.push(...documents.get(key)!);
    else clusters.set(root(position), [...documents.get(key)!]);
  });
  const batches: number[][] = [];
  let current: number[] = [];
  for (const group of clusters.values()) {
    for (let offset = 0; offset < group.length; offset += maxRows) {
      const part = group.slice(offset, offset + maxRows);
      if (current.length + part.length > maxRows) { batches.push(current); current = []; }
      current.push(...part);
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/** The fields sent to the model for one row: no file name, no client or dossier name. */
export function semanticRowPayload(entry: LedgerEntry, index: number) {
  return { index, date: entry.date, accountCode: entry.accountCode, accountLabel: entry.accountLabel, reference: entry.reference, description: entry.description, debit: entry.debit, credit: entry.credit };
}

/** Turns a checked prediction into a finding with a stable ID; null if none of its rows exist. */
export function semanticFinding(prediction: SemanticPrediction, entries: LedgerEntry[]): AuditFinding | null {
  const rows = [...new Set(prediction.rowIndices)].map((index) => entries[index]).filter((entry): entry is LedgerEntry => Boolean(entry));
  if (!rows.length || !prediction.code.startsWith('IA-')) return null;
  return {
    id: findingId(prediction.code, rows),
    ruleCode: prediction.code,
    severity: prediction.severity,
    title: prediction.title,
    explanation: prediction.explanation,
    sourceRowIds: rows.map((row) => row.id),
    amount: prediction.amount,
    suggestion: SEMANTIC_SUGGESTION,
    status: 'open',
    origin: 'semantic',
    confidence: prediction.confidence,
  };
}

/** Level 1 rules that describe a whole account or perimeter, not one document: never a merge target. */
const ACCOUNT_LEVEL_RULES = new Set(['BAL-01', 'BAL-02', 'BAL-03', 'CGNC-01']);
/** Level 1 rules that test the same thing as a Level 2 code, preferred when several constats match. */
const RELATED_RULES: Record<string, string[]> = {
  'IA-DUP-01': ['DUP-01'],
  'IA-DED-01': ['FISC-02', 'FISC-01'],
  'IA-TVA-01': ['TVA-01', 'FISC-03'],
  'IA-PER-01': ['PER-01', 'ECR-04'],
  'IA-TIE-01': ['REG-01'],
};

/**
 * The Level 1 constat that concerns the same document or line as a Level 2 prediction, if any:
 * it shares a source row or a document number. A related rule (FISC-02 for IA-DED-01…) wins over
 * an unrelated one, then the largest overlap.
 */
export function level1Match(prediction: AuditFinding, level1: AuditFinding[], entries: LedgerEntry[]): AuditFinding | null {
  const rows = new Set(prediction.sourceRowIds);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const referenceOf = (id: string) => byId.get(id)?.reference.trim().toLowerCase() || '';
  const references = new Set(prediction.sourceRowIds.map(referenceOf).filter(Boolean));
  const related = RELATED_RULES[prediction.ruleCode] || [];
  let best: { finding: AuditFinding; score: number } | null = null;
  for (const finding of level1) {
    if (finding.origin === 'semantic' || ACCOUNT_LEVEL_RULES.has(finding.ruleCode)) continue;
    const shared = finding.sourceRowIds.filter((id) => rows.has(id)).length;
    const sameDocument = finding.sourceRowIds.some((id) => references.has(referenceOf(id)));
    if (!shared && !sameDocument) continue;
    const score = (related.includes(finding.ruleCode) ? 1000 : 0) + shared * 10 + (sameDocument ? 1 : 0);
    if (!best || score > best.score) best = { finding, score };
  }
  return best?.finding || null;
}

/**
 * A Level 1 constat with the accepted Level 2 predictions folded into it: one line in the working
 * file and the report, whose explanation carries the AI reading as well.
 */
export function enrichLevel1Finding(finding: AuditFinding, merged: AuditFinding[]): AuditFinding {
  if (!merged.length) return finding;
  const notes = merged.map((item) => `Analyse IA Niveau 2 (${item.ruleCode}, confiance ${item.confidence || 'faible'}) : ${item.explanation}`);
  return { ...finding, explanation: `${finding.explanation}\n${notes.join('\n')}`, mergedSemantic: merged };
}

const DECISION_LABEL: Record<Exclude<SemanticDecision, 'pending'>, string> = { merged: 'fusionné', rejected: 'rejeté' };

/**
 * The constats table has no column for a Level 2 decision or its rows, so both are written into
 * the human-readable cell reference, e.g. "Niveau 2 IA · fusionné · confiance moyenne · lignes 12, 13",
 * or "Niveau 2 IA · fusionné dans FISC-02-… · confiance …" when folded into a Level 1 constat.
 */
export function semanticCellReference(decision: Exclude<SemanticDecision, 'pending'>, confidence: SemanticConfidence | undefined, rows: LedgerEntry[], mergedInto?: string): string {
  const target = decision === 'merged' && mergedInto ? ` dans ${mergedInto}` : '';
  return `Niveau 2 IA · ${DECISION_LABEL[decision]}${target} · confiance ${confidence || 'faible'} · lignes ${rows.map((row) => row.sourceRow).join(', ')}`.slice(0, 2000);
}

export function parseSemanticCellReference(value: string): { decision: Exclude<SemanticDecision, 'pending'>; confidence: SemanticConfidence; sourceRows: number[]; mergedInto?: string } | null {
  const match = /^Niveau 2 IA · (fusionné|rejeté)(?: dans (\S+))? · confiance (faible|moyenne|élevée) · lignes ([\d, ]+)$/.exec(value.trim());
  if (!match) return null;
  const sourceRows = match[4].split(',').map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0);
  return { decision: match[1] === 'fusionné' ? 'merged' : 'rejected', confidence: match[3] as SemanticConfidence, sourceRows, ...(match[2] ? { mergedInto: match[2] } : {}) };
}

/** Rebuilds a saved Level 2 constat; its stored explanation is "title — explanation". */
export function semanticItemFromConstat(
  record: { id: string; importId: string; ruleCode: string; severity: string; amount: number; explanation: string; cellReference: string },
  entries: LedgerEntry[],
): SemanticItem | null {
  if (!record.ruleCode.startsWith('IA-')) return null;
  const parsed = parseSemanticCellReference(record.cellReference || '');
  if (!parsed) return null;
  const bySourceRow = new Map(entries.map((entry) => [entry.sourceRow, entry]));
  const rows = parsed.sourceRows.map((row) => bySourceRow.get(row)).filter((entry): entry is LedgerEntry => Boolean(entry));
  if (!rows.length) return null;
  const separator = record.explanation.indexOf(' — ');
  const severity = (['high', 'medium', 'low', 'info'] as const).find((value) => value === record.severity) || 'medium';
  return {
    datasetId: record.importId,
    decision: parsed.decision,
    ...(parsed.mergedInto ? { mergedInto: parsed.mergedInto } : {}),
    finding: {
      id: record.id,
      ruleCode: record.ruleCode,
      severity,
      title: separator > 0 ? record.explanation.slice(0, separator) : record.ruleCode,
      explanation: separator > 0 ? record.explanation.slice(separator + 3) : record.explanation,
      sourceRowIds: rows.map((row) => row.id),
      amount: Number(record.amount) || 0,
      suggestion: SEMANTIC_SUGGESTION,
      status: 'open',
      origin: 'semantic',
      confidence: parsed.confidence,
    },
  };
}
