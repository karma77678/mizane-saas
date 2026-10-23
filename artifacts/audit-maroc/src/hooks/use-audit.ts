import { useEffect, useMemo, useRef, useState } from 'react';
import { runAudit } from '@/lib/audit-engine';
import { parseAmount } from '@/lib/parse-amount';
import { enrichLevel1Finding, level1Match, semanticCellReference, semanticFinding, semanticItemFromConstat, type SemanticDecision, type SemanticItem, type SemanticPrediction } from '@/lib/semantic';
import {
  apiFetch,
  apiJson,
  errorMessage,
  IMPORT_TIMEOUT_MS,
  jsonBody,
  WRITE_TIMEOUT_MS,
} from '@/lib/api';

/** Outcome of an import attempt. A failure always carries a displayable reason. */
export type ImportOutcome = { ok: true; rowCount: number } | { ok: false; error: string };

/** Keep in step with the API's JSONB guard in POST /api/imports. */
const MAX_IMPORT_PAYLOAD_BYTES = 45_000_000;

export type LedgerEntry = {
  id: string;
  date: string;
  journal: string;
  accountCode: string;
  accountLabel: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  sourceFile: string;
  sourceRow: number;
  amountParseError?: boolean;
};
export type AuditFinding = {
  id: string;
  ruleCode: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  explanation: string;
  sourceRowIds: string[];
  amount: number;
  suggestion: string;
  status: 'open' | 'reviewed' | 'dismissed';
  /** Absent for Level 1 (deterministic) findings; "semantic" for a Level 2 AI prediction. */
  origin?: 'deterministic' | 'semantic';
  confidence?: 'faible' | 'moyenne' | 'élevée';
  /** On a Level 1 constat: the accepted Level 2 predictions folded into it (same document or line). */
  mergedSemantic?: AuditFinding[];
};
export type Proposal = {
  id: string;
  findingId: string;
  description: string;
  lines: string[];
  status: 'proposed' | 'accepted' | 'rejected';
  journalEntry?: { accountCode: string; accountLabel: string; debit: number; credit: number; rationale: string }[];
  prerequisites?: string[];
  confidence?: 'faible' | 'moyenne' | 'élevée';
  appliedAt?: string;
};
export type Dataset = {
  id: string;
  name: string;
  type: string;
  documentType: 'journal' | 'grand_livre' | 'balance' | 'autre';
  period: string;
  entries: LedgerEntry[];
  importedAt: string;
  headers: string[];
  sourceRows: string[][];
  mapping: ColumnMap;
  dossierId?: string;
};
/** Returns the exact source-grid columns that are relevant to a finding, zero-based. */
export function highlightedSourceColumns(finding: AuditFinding, dataset: Dataset, entry: LedgerEntry): number[] {
  const result = new Set<number>();
  const add = (key: keyof ColumnMap) => {
    const value = dataset.mapping?.[key];
    if (value !== undefined && value !== '') {
      const index = Number(value);
      if (Number.isInteger(index) && index >= 0 && index < dataset.headers.length) result.add(index);
    }
  };
  const addAmounts = () => { add('debit'); add('credit'); };
  // Level 2 predictions rest on wording: the account and the labels are what the auditor checks.
  if (finding.origin === 'semantic') {
    add('accountCode'); add('accountLabel'); add('description'); addAmounts();
    return [...result];
  }
  switch (finding.ruleCode) {
    case 'ECR-07': {
      const row = dataset.sourceRows?.[entry.sourceRow - 2] || [];
      for (const key of ['debit', 'credit'] as const) {
        const raw = dataset.mapping?.[key];
        if (raw !== undefined && raw !== '' && parseAmount(row[Number(raw)] || '').invalid) add(key);
      }
      if (!result.size) addAmounts();
      break;
    }
    case 'ECR-02': addAmounts(); break;
    case 'ECR-08':
      if (entry.debit < 0) add('debit');
      if (entry.credit < 0) add('credit');
      break;
    case 'ECR-03':
      if (!entry.accountCode.trim()) add('accountCode');
      if (!entry.accountLabel.trim()) add('accountLabel');
      break;
    case 'ECR-04': case 'PER-01': add('date'); break;
    case 'ECR-06': add('reference'); break;
    case 'REG-01': add('accountCode'); add('journal'); add('reference'); add('debit'); break;
    case 'ECR-01': case 'DUP-01': add('date'); add('journal'); add('reference'); add('accountCode'); addAmounts(); break;
    case 'BAL-01': case 'BAL-03': addAmounts(); break;
    case 'BAL-02': case 'CGNC-01': add('accountCode'); addAmounts(); break;
    case 'FISC-01': add('accountCode'); add('reference'); addAmounts(); break;
    case 'FISC-02': add('accountCode'); addAmounts(); break;
    case 'FISC-03': case 'TVA-01': add('accountCode'); addAmounts(); break;
    default: addAmounts(); break;
  }
  return [...result];
}

export type TrailItem = { id: string; at: string; action: string; detail: string };
export type ColumnMap = {
  date: string;
  journal: string;
  accountCode: string;
  accountLabel: string;
  reference: string;
  description: string;
  debit: string;
  credit: string;
};
export type AuditSettings = {
  fiscalYear: number;
  vatRates: number[];
  vatCollectedPrefixes: string[];
  vatRecoverablePrefixes: string[];
  keepLocal: boolean;
};
type Workspace = {
  datasets: Dataset[];
  activeDatasetId: string | null;
  trail: TrailItem[];
  settings: AuditSettings;
  proposals: Proposal[];
  findingStatus: Record<string, AuditFinding['status']>;
  /** Level 2 AI predictions: pending ones live for the session, decided ones are saved as constats. */
  semantic: SemanticItem[];
};

const initialSettings: AuditSettings = {
  fiscalYear: new Date().getFullYear(),
  vatRates: [],
  vatCollectedPrefixes: [],
  vatRecoverablePrefixes: [],
  keepLocal: true,
};
const initialWorkspace: Workspace = {
  datasets: [],
  activeDatasetId: null,
  trail: [],
  settings: initialSettings,
  proposals: [],
  findingStatus: {},
  semantic: [],
};
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Re-exported so existing importers keep working; the implementation moved to
// its own module to be unit-testable without loading React.
export { parseAmount };

export function useAudit(dossierId: string | null, dossierYear?: number, dossierSettings?: Partial<AuditSettings> | null) {
  const [workspace, setWorkspace] = useState<Workspace>({
    ...initialWorkspace,
    settings: { ...initialSettings, ...(dossierSettings || {}), fiscalYear: dossierSettings?.fiscalYear || dossierYear || new Date().getFullYear() },
  });
  const [persistenceError, setPersistenceError] = useState('');
  const [loadingDossier, setLoadingDossier] = useState(false);
  const [readyDossierId, setReadyDossierId] = useState<string | null>(null);
  // Never render the previous client's data while the newly selected dossier is loading.
  const emptyWorkspace: Workspace = {
    ...initialWorkspace,
    settings: { ...initialSettings, ...(dossierSettings || {}), fiscalYear: dossierSettings?.fiscalYear || dossierYear || new Date().getFullYear() },
  };
  const visibleWorkspace = dossierId && readyDossierId === dossierId ? workspace : emptyWorkspace;

  useEffect(() => {
    let cancelled = false;
    if (!dossierId) {
      setWorkspace({ ...initialWorkspace, settings: { ...initialSettings, ...(dossierSettings || {}), fiscalYear: dossierSettings?.fiscalYear || dossierYear || new Date().getFullYear() } });
      setReadyDossierId(null);
      setLoadingDossier(false);
      return () => { cancelled = true; };
    }
    setReadyDossierId(null);
    setLoadingDossier(true);
    setPersistenceError('');
    const loadRemoteDossier = async () => {
      try {
        const [importPayload, constatsPayload] = await Promise.all([
          apiJson<{ imports: { id: string; fileName: string; fileDataJson: Record<string, unknown>; createdAt: string }[] }>(
            `/api/imports?dossierId=${encodeURIComponent(dossierId)}`,
          ),
          apiJson<{ constats: { id: string; importId: string; ruleCode: string; severity: string; amount: number; explanation: string; cellReference: string; status: 'A_EXAMINER' | 'VERIFIE' | 'ECARTE'; proposedCorrection: unknown }[] }>(
            `/api/constats?dossierId=${encodeURIComponent(dossierId)}`,
          ),
        ]);
        const datasets: Dataset[] = (importPayload.imports || []).map((record) => {
          const data = record.fileDataJson as Partial<Dataset>;
          return {
            id: record.id,
            name: record.fileName,
            type: typeof data.type === 'string' ? data.type : record.fileName.split('.').pop()?.toUpperCase() || 'CSV',
            documentType: data.documentType === 'grand_livre' || data.documentType === 'balance' || data.documentType === 'autre' ? data.documentType : 'journal',
            period: typeof data.period === 'string' ? data.period : String(dossierYear || new Date().getFullYear()),
            entries: Array.isArray(data.entries) ? data.entries as LedgerEntry[] : [],
            importedAt: typeof data.importedAt === 'string' ? data.importedAt : record.createdAt,
            headers: Array.isArray(data.headers) ? data.headers : [],
            sourceRows: Array.isArray(data.sourceRows) ? data.sourceRows : [],
            mapping: data.mapping || { date:'', journal:'', accountCode:'', accountLabel:'', reference:'', description:'', debit:'', credit:'' },
            dossierId,
          };
        });
        const findingStatus: Workspace['findingStatus'] = {};
        const proposals: Proposal[] = [];
        const semantic: SemanticItem[] = [];
        const entriesByImport = new Map(datasets.map((dataset) => [dataset.id, dataset.entries]));
        for (const item of constatsPayload.constats || []) {
          const saved = semanticItemFromConstat(item, entriesByImport.get(item.importId) || []);
          if (saved) semantic.push(saved);
          findingStatus[item.id] = item.status === 'VERIFIE' ? 'reviewed' : item.status === 'ECARTE' ? 'dismissed' : 'open';
          if (item.proposedCorrection && typeof item.proposedCorrection === 'object') {
            const candidate = item.proposedCorrection as Proposal;
            if (candidate.id && candidate.findingId && candidate.description && Array.isArray(candidate.lines) && candidate.status) proposals.push(candidate);
          }
        }
        if (cancelled) return;
        setWorkspace({
          ...initialWorkspace,
          datasets,
          activeDatasetId: datasets.at(-1)?.id || null,
          findingStatus,
          proposals,
          semantic,
          settings: { ...initialSettings, ...(dossierSettings || {}), fiscalYear: dossierSettings?.fiscalYear || dossierYear || Number(datasets.at(-1)?.period) || new Date().getFullYear() },
          trail: [{ id: uid(), at: new Date().toISOString(), action: 'Dossier chargé', detail: `${datasets.length} import(s) récupéré(s) depuis PostgreSQL` }],
        });
        setReadyDossierId(dossierId);
      } catch (error) {
        if (!cancelled) {
          setPersistenceError(errorMessage(error, 'Erreur de chargement du dossier.'));
          // Leaving `readyDossierId` null is what keeps a half-loaded dossier
          // from accepting writes; the banner above explains why.
        }
      } finally {
        if (!cancelled) setLoadingDossier(false);
      }
    };
    void loadRemoteDossier();
    return () => { cancelled = true; };
  }, [dossierId, dossierYear, dossierSettings]);

  const activeDataset =
    visibleWorkspace.datasets.find((dataset) => dataset.id === visibleWorkspace.activeDatasetId) ||
    visibleWorkspace.datasets.at(-1);
  const entries = useMemo(() => activeDataset?.entries || [], [activeDataset]);
  const totalDebit = entries.reduce((sum, entry) => sum + entry.debit, 0);
  const totalCredit = entries.reduce((sum, entry) => sum + entry.credit, 0);
  const deterministicFindings = useMemo(
    () =>
      runAudit(
        entries,
        {
          documentType: activeDataset?.documentType || 'journal',
          fiscalYear: visibleWorkspace.settings.fiscalYear,
          vatRates: visibleWorkspace.settings.vatRates,
          vatCollectedPrefixes: visibleWorkspace.settings.vatCollectedPrefixes || [],
          vatRecoverablePrefixes: visibleWorkspace.settings.vatRecoverablePrefixes || [],
        },
        visibleWorkspace.findingStatus,
      ),
    [entries, activeDataset?.documentType, visibleWorkspace.settings, visibleWorkspace.findingStatus],
  );
  // Each prediction carries the Level 1 constat on the same document or line, if any: the one it
  // was folded into once accepted, or the one it would be folded into while still pending.
  const semanticItems = useMemo(
    () => visibleWorkspace.semantic
      .filter((item) => item.datasetId === activeDataset?.id)
      .map((item) => {
        const finding = { ...item.finding, status: visibleWorkspace.findingStatus[item.finding.id] || item.finding.status };
        const level1 = item.decision === 'merged'
          ? deterministicFindings.find((candidate) => candidate.id === item.mergedInto) || null
          : level1Match(finding, deterministicFindings, entries);
        return { ...item, finding, level1 };
      }),
    [visibleWorkspace.semantic, visibleWorkspace.findingStatus, activeDataset?.id, deterministicFindings, entries],
  );
  // The working file: Level 1 constats, enriched with the predictions folded into them, plus the
  // accepted predictions on a document no Level 1 constat covers. One line per anomaly.
  const findings = useMemo(() => {
    const folded = new Map<string, AuditFinding[]>();
    const added: AuditFinding[] = [];
    for (const item of semanticItems) {
      if (item.decision !== 'merged') continue;
      if (item.level1) folded.set(item.level1.id, [...(folded.get(item.level1.id) || []), item.finding]);
      else added.push(item.finding);
    }
    return [...deterministicFindings.map((finding) => enrichLevel1Finding(finding, folded.get(finding.id) || [])), ...added];
  }, [deterministicFindings, semanticItems]);

  const importRows = async (
    fileName: string,
    rows: string[][],
    map: ColumnMap,
    period: string,
    documentType: Dataset['documentType'],
    headers: string[],
  ): Promise<ImportOutcome> => {
    // Every rejection below used to `return false` silently, which left the
    // caller with no reason to show. Each one now names its own cause.
    const reject = (error: string): ImportOutcome => {
      setPersistenceError(error);
      return { ok: false, error };
    };

    if (!dossierId) return reject('Aucun dossier actif. Sélectionnez un dossier client avant d’importer un fichier.');
    if (readyDossierId !== dossierId) {
      return reject('Le dossier est encore en cours de chargement, ou son chargement a échoué. Attendez la fin du chargement puis réessayez.');
    }
    if (!fileName.trim()) return reject('Le nom du fichier est manquant. Resélectionnez le fichier à importer.');
    if (!rows.length) return reject('Aucune ligne de données n’a été lue dans ce fichier.');
    if (!map.debit || !map.credit) return reject('Associez les colonnes Débit et Crédit avant de confirmer l’importation.');
    if (documentType === 'balance') {
      if (!map.accountCode && !map.accountLabel) {
        return reject('Pour une balance, associez au minimum une colonne Code compte ou Libellé compte.');
      }
    } else if (!map.date) {
      return reject('Associez la colonne Date avant de confirmer l’importation.');
    }
    const get = (row: string[], key: keyof ColumnMap, fallback = '') => map[key] !== '' ? row[Number(map[key])] || fallback : fallback;
    const imported: LedgerEntry[] = rows.map((row, index) => {
      const debit = parseAmount(get(row, 'debit'));
      const credit = parseAmount(get(row, 'credit'));
      return {
        id: uid(), date: get(row, 'date'), journal: get(row, 'journal'), accountCode: get(row, 'accountCode'),
        accountLabel: get(row, 'accountLabel'), reference: get(row, 'reference'), description: get(row, 'description'),
        debit: debit.value, credit: credit.value, amountParseError: debit.invalid || credit.invalid,
        sourceFile: fileName, sourceRow: index + 2,
      };
    }).filter((entry) => entry.date || entry.accountCode || entry.accountLabel || entry.debit || entry.credit || entry.amountParseError);
    if (!imported.length) {
      return reject('Aucune ligne exploitable après association des colonnes. Vérifiez que les colonnes associées contiennent bien des données.');
    }
    const datasetPayload = {
      type: fileName.split('.').pop()?.toUpperCase() || 'CSV', documentType, period,
      entries: imported, importedAt: new Date().toISOString(), headers, sourceRows: rows, mapping: map,
    };

    let requestBody: string;
    try {
      requestBody = JSON.stringify({ dossierId, fileName, fileDataJson: datasetPayload });
    } catch {
      return reject('Le fichier est trop volumineux pour être préparé par le navigateur. Importez-le par période ou par feuille.');
    }
    // Fail locally with a useful message rather than leaving the browser
    // waiting on a request the API is bound to refuse.
    if (requestBody.length > MAX_IMPORT_PAYLOAD_BYTES) {
      return reject(
        `Le fichier structuré pèse ${(requestBody.length / 1_000_000).toFixed(1)} Mo et dépasse la limite de 45 Mo. ` +
          'Importez-le par période ou par feuille.',
      );
    }

    try {
      const payload = await apiJson<{ import?: { id: string; createdAt: string } }>('/api/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Already serialised above so the size could be checked first.
        body: requestBody,
        timeoutMs: IMPORT_TIMEOUT_MS,
      });
      if (!payload.import?.id) {
        return reject('Le serveur a accepté la requête sans renvoyer d’identifiant d’import. L’import n’a pas été confirmé.');
      }
      const dataset: Dataset = { ...datasetPayload, id: payload.import.id, name: fileName, dossierId, importedAt: payload.import.createdAt || datasetPayload.importedAt };
      setWorkspace((current) => ({
        ...current, datasets: [...current.datasets, dataset], activeDatasetId: dataset.id,
        trail: [{ id: uid(), at: new Date().toISOString(), action: 'Importation persistée', detail: `${fileName} · ${imported.length} lignes enregistrées dans PostgreSQL` }, ...current.trail].slice(0, 300),
      }));
      setPersistenceError('');
      return { ok: true, rowCount: imported.length };
    } catch (error) {
      return reject(errorMessage(error, 'L’import n’a pas pu être enregistré dans PostgreSQL.'));
    }
  };

  const statusForApi = (status: AuditFinding['status']) => status === 'reviewed' ? 'VERIFIE' : status === 'dismissed' ? 'ECARTE' : 'A_EXAMINER';
  const makeConstatPayload = (finding: AuditFinding, status = finding.status, proposedCorrection?: Proposal | null, decision?: Exclude<SemanticDecision, 'pending'>, mergedInto?: string) => {
    const sourceEntries = entries.filter((entry) => finding.sourceRowIds.includes(entry.id));
    const saved = finding.origin === 'semantic' ? workspace.semantic.find((item) => item.finding.id === finding.id) : undefined;
    const semanticDecision = finding.origin === 'semantic'
      ? decision || (saved?.decision === 'rejected' ? 'rejected' : 'merged')
      : null;
    const semanticTarget = decision ? mergedInto : saved?.mergedInto;
    const cellRefs = sourceEntries.slice(0, 50).flatMap((entry) => {
      if (!activeDataset) return [`Ligne ${entry.sourceRow}`];
      const columns = highlightedSourceColumns(finding, activeDataset, entry);
      return columns.map((index) => `Ligne ${entry.sourceRow}, colonne ${activeDataset.headers[index] || `Colonne ${index + 1}`}`);
    });
    return {
      id: finding.id, ruleCode: finding.ruleCode, severity: finding.severity, amount: finding.amount,
      explanation: `${finding.title} — ${finding.explanation}`,
      cellReference: semanticDecision
        ? semanticCellReference(semanticDecision, finding.confidence, sourceEntries, semanticTarget)
        : [...new Set(cellRefs)].join(' ; ').slice(0, 2000) || 'Cellule à vérifier dans la source',
      status: statusForApi(status), proposedCorrection: proposedCorrection === undefined ? workspace.proposals.find((item) => item.findingId === finding.id) || null : proposedCorrection,
    };
  };
  const persistFindingUpdate = async (finding: AuditFinding, status = finding.status, proposedCorrection?: Proposal | null, decision?: Exclude<SemanticDecision, 'pending'>, mergedInto?: string) => {
    if (!dossierId || readyDossierId !== dossierId || !activeDataset) return;
    try {
      // The constat row must exist before it can be patched.
      await apiFetch(`/api/dossiers/${encodeURIComponent(dossierId)}/constats/sync`, {
        method: 'PUT',
        ...jsonBody({ importId: activeDataset.id, constats: [makeConstatPayload(finding, status, proposedCorrection, decision, mergedInto)] }),
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      await apiFetch(`/api/constats/${encodeURIComponent(finding.id)}`, {
        method: 'PATCH',
        ...jsonBody({ status: statusForApi(status), ...(proposedCorrection !== undefined ? { proposedCorrection } : {}) }),
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      setPersistenceError('');
    } catch (error) {
      setPersistenceError(errorMessage(error, 'Impossible d’enregistrer cette décision dans PostgreSQL.'));
    }
  };

  const selectDataset = (id: string) =>
    setWorkspace((current) => ({ ...current, activeDatasetId: id }));
  const addTrail = (action: string, detail: string) =>
    setWorkspace((current) => ({
      ...current,
      trail: [
        { id: uid(), at: new Date().toISOString(), action, detail },
        ...current.trail,
      ].slice(0, 300),
    }));
  const setFindingStatus = (finding: AuditFinding, status: AuditFinding['status']) => {
    setWorkspace((current) => ({
      ...current, findingStatus: { ...current.findingStatus, [finding.id]: status },
      trail: [{ id: uid(), at: new Date().toISOString(), action: status === 'reviewed' ? 'Constat vérifié' : 'Constat écarté', detail: `${finding.ruleCode} · ${finding.title}` }, ...current.trail].slice(0, 300),
    }));
    void persistFindingUpdate(finding, status);
  };
  const propose = (finding: AuditFinding) => {
    if (workspace.proposals.some((item) => item.findingId === finding.id)) return;
    const proposal: Proposal = { id: uid(), findingId: finding.id, description: finding.suggestion, lines: finding.sourceRowIds, status: 'proposed' };
    setWorkspace((current) => ({
      ...current, proposals: [...current.proposals, proposal],
      trail: [{ id: uid(), at: new Date().toISOString(), action: 'Proposition créée', detail: `${finding.ruleCode} · à valider manuellement` }, ...current.trail].slice(0, 300),
    }));
    void persistFindingUpdate(finding, finding.status, proposal);
  };
  const updateProposal = (proposal: Proposal, status: Proposal['status']) => {
    const updatedProposal = { ...proposal, status, ...(status === 'accepted' ? { appliedAt: new Date().toISOString() } : {}) };
    setWorkspace((current) => ({
      ...current, proposals: current.proposals.map((item) => item.id === proposal.id ? updatedProposal : item),
      trail: [{ id: uid(), at: new Date().toISOString(), action: status === 'accepted' ? 'Correction confirmée et appliquée au dossier de travail' : 'Proposition refusée', detail: proposal.description }, ...current.trail].slice(0, 300),
    }));
    const finding = findings.find((item) => item.id === proposal.findingId);
    if (finding) void persistFindingUpdate(finding, finding.status, updatedProposal);
  };
  const updateProposalWithAi = (finding: AuditFinding, aiDraft: Omit<Proposal, 'id' | 'findingId' | 'lines' | 'status'>) => {
    const existing = workspace.proposals.find((item) => item.findingId === finding.id);
    const proposal: Proposal = {
      ...(existing || {} as Proposal), id: existing?.id || uid(), findingId: finding.id,
      description: aiDraft.description, lines: finding.sourceRowIds, status: 'proposed',
      journalEntry: aiDraft.journalEntry, prerequisites: aiDraft.prerequisites, confidence: aiDraft.confidence,
    };
    setWorkspace((current) => ({
      ...current, proposals: [...current.proposals.filter((item) => item.findingId !== finding.id), proposal],
      trail: [{ id: uid(), at: new Date().toISOString(), action: 'Proposition IA générée', detail: `${finding.ruleCode} · en attente de confirmation humaine` }, ...current.trail].slice(0, 300),
    }));
    void persistFindingUpdate(finding, finding.status, proposal);
  };

  /** Adds the checked predictions of one batch as pending items; an already known ID keeps its decision. */
  const addSemanticPredictions = (datasetId: string, predictions: SemanticPrediction[], datasetEntries: LedgerEntry[]) => {
    const known = new Set([...workspace.semantic.map((item) => item.finding.id), ...deterministicFindings.map((item) => item.id)]);
    const fresh: SemanticItem[] = [];
    for (const prediction of predictions) {
      const finding = semanticFinding(prediction, datasetEntries);
      if (!finding || known.has(finding.id)) continue;
      known.add(finding.id);
      fresh.push({ finding, decision: 'pending', datasetId });
    }
    if (fresh.length) setWorkspace((current) => ({ ...current, semantic: [...current.semantic, ...fresh.filter((item) => !current.semantic.some((existing) => existing.finding.id === item.finding.id))] }));
    return fresh.length;
  };
  /**
   * Accepting a prediction on a document or line a Level 1 constat already covers folds it into
   * that constat (case A); otherwise it becomes a constat of its own (case B). Rejecting leaves
   * the working file untouched.
   */
  const decideSemantic = (item: SemanticItem, decision: Exclude<SemanticDecision, 'pending'>) => {
    const status: AuditFinding['status'] = decision === 'merged' ? 'open' : 'dismissed';
    const target = decision === 'merged' ? level1Match(item.finding, deterministicFindings, entries) : null;
    const action = decision === 'rejected'
      ? 'Constat IA rejeté'
      : target ? `Constat IA fusionné dans le constat Niveau 1 ${target.ruleCode}` : 'Constat IA accepté et ajouté au dossier de travail';
    setWorkspace((current) => ({
      ...current,
      semantic: current.semantic.map((existing) => {
        if (existing.finding.id !== item.finding.id) return existing;
        const { mergedInto: _previous, ...rest } = existing;
        return target ? { ...rest, decision, mergedInto: target.id } : { ...rest, decision };
      }),
      findingStatus: { ...current.findingStatus, [item.finding.id]: status },
      trail: [{ id: uid(), at: new Date().toISOString(), action, detail: `${item.finding.ruleCode} · ${item.finding.title}` }, ...current.trail].slice(0, 300),
    }));
    void persistFindingUpdate({ ...item.finding, status }, status, undefined, decision, target?.id);
  };
  const clearPendingSemantic = (datasetId: string) =>
    setWorkspace((current) => ({ ...current, semantic: current.semantic.filter((item) => item.datasetId !== datasetId || item.decision !== 'pending') }));

  const updateSettings = async (settings: AuditSettings): Promise<boolean> => {
    setWorkspace((current) => ({
      ...current, settings,
      trail: [{ id: uid(), at: new Date().toISOString(), action: 'Paramètres modifiés', detail: `Exercice ${settings.fiscalYear} · TVA ${settings.vatRates.join(' %, ')} %` }, ...current.trail].slice(0, 300),
    }));
    if (!dossierId || readyDossierId !== dossierId) {
      setPersistenceError('Sélectionnez un dossier chargé avant de modifier ses paramètres.');
      return false;
    }
    try {
      await apiFetch(`/api/dossiers/${encodeURIComponent(dossierId)}/settings`, {
        method: 'PATCH',
        ...jsonBody({ settings: { fiscalYear: settings.fiscalYear, vatRates: settings.vatRates, vatCollectedPrefixes: settings.vatCollectedPrefixes, vatRecoverablePrefixes: settings.vatRecoverablePrefixes } }),
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      setPersistenceError('');
      return true;
    } catch (error) {
      setPersistenceError(errorMessage(error, 'Impossible d’enregistrer les paramètres du dossier.'));
      return false;
    }
  };
  const clearLocalData = async () => {
    if (!dossierId) return;
    try {
      await apiFetch(`/api/dossiers/${encodeURIComponent(dossierId)}/imports`, {
        method: 'DELETE',
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      setWorkspace({ ...initialWorkspace, settings: workspace.settings });
      setPersistenceError('');
    } catch (error) {
      setPersistenceError(errorMessage(error, 'Impossible de supprimer les imports du dossier.'));
    }
  };

  // Background mirroring of the computed constats into PostgreSQL.
  //
  // `findings` is recomputed on every data change, so this used to be able to
  // fire several thousand-row syncs at once, each one queued behind the last.
  // It is now debounced, deduplicated by payload and limited to one in-flight
  // request, and it is skipped entirely while a request is already running.
  const syncInFlight = useRef(false);
  const lastSyncedSignature = useRef('');
  useEffect(() => {
    if (!dossierId || readyDossierId !== dossierId || !activeDataset) return;

    const body = JSON.stringify({
      importId: activeDataset.id,
      constats: findings.map((finding) => makeConstatPayload(finding)),
    });
    if (body === lastSyncedSignature.current) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled || syncInFlight.current) return;
      syncInFlight.current = true;
      try {
        await apiFetch(`/api/dossiers/${encodeURIComponent(dossierId)}/constats/sync`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
          timeoutMs: WRITE_TIMEOUT_MS,
        });
        lastSyncedSignature.current = body;
        if (!cancelled) setPersistenceError('');
      } catch (error) {
        if (!cancelled) {
          setPersistenceError(errorMessage(error, 'Les constats n’ont pas pu être synchronisés dans PostgreSQL.'));
        }
      } finally {
        syncInFlight.current = false;
      }
    }, 400);

    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [dossierId, readyDossierId, activeDataset?.id, findings, workspace.proposals]);

  return {
    workspace: visibleWorkspace,
    activeDataset,
    loadingDossier,
    readyDossierId,
    entries,
    findings,
    deterministicFindings,
    semanticItems,
    addSemanticPredictions,
    decideSemantic,
    clearPendingSemantic,
    totalDebit,
    totalCredit,
    importRows,
    selectDataset,
    persistenceError,
    setFindingStatus,
    propose,
    updateProposal,
    updateProposalWithAi,
    updateSettings,
    clearLocalData,
    trail: addTrail,
  };
}
