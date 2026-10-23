import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type ChangeEvent, type DragEvent } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { useReviewAuditWithAi } from '@workspace/api-client-react';
import { Activity, ArrowDownToLine, ArrowRight, BadgeCheck, BookOpenCheck, Check, ChevronDown, CircleAlert, CircleHelp, ClipboardCheck, Cpu, Database, FileCheck2, FileSpreadsheet, FileUp, Filter, FolderPlus, Gauge, KeyRound, Landmark, Layers, LockKeyhole, LogOut, Plus, RotateCcw, Search, Settings2, ShieldCheck, Sparkles, Trash2, X, Eye, PanelRightClose } from 'lucide-react';
import NotFound from '@/pages/not-found';
import { useAudit, highlightedSourceColumns, type AuditFinding, type AuditSettings, type ColumnMap, type Dataset, type Proposal } from '@/hooks/use-audit';
import { guessColumnMap } from '@/lib/column-mapping';
import { readAccountingFile } from '@/lib/file-import';
import { AuthGate, useAuth } from '@/components/auth-gate';
import { AI_TIMEOUT_MS, ApiError, apiJson, errorMessage, jsonBody } from '@/lib/api';
import { buildSemanticBatches, semanticRowPayload, SEMANTIC_BATCH_ROWS, SEMANTIC_SCOPE_ROWS, type SemanticItem, type SemanticPrediction } from '@/lib/semantic';
import './index.css';

const queryClient = new QueryClient();
const navItems = [
  { href: '/', label: 'Vue d’ensemble', icon: Activity },
  { href: '/import', label: 'Importer', icon: FileUp },
  { href: '/audit', label: 'Revue d’audit', icon: ClipboardCheck },
  { href: '/settings', label: 'Paramètres', icon: Settings2 },
  { href: '/usage', label: 'Consommation IA', icon: Gauge },
];
const AI_USAGE_KEY = ['ai-usage'] as const;
type WorkspaceApi = ReturnType<typeof useAudit>;
const AuditContext = createContext<WorkspaceApi | null>(null);
function useWorkspace() { const value = useContext(AuditContext); if (!value) throw new Error('Workspace manquant'); return value; }
function formatMad(value: number) { return new Intl.NumberFormat('fr-MA', { style: 'currency', currency: 'MAD', maximumFractionDigits: 2 }).format(value); }
function formatNumber(value: number) { return new Intl.NumberFormat('fr-MA', { maximumFractionDigits: 2 }).format(value); }
function shortDate(value: string) { return new Intl.DateTimeFormat('fr-MA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { workspace, activeDataset, selectDataset, persistenceError, loadingDossier } = useWorkspace();
  const auth = useAuth();
  const createDossier = async () => {
    const clientName = window.prompt('Nom du client / dossier :');
    if (!clientName?.trim()) return;
    const yearText = window.prompt('Exercice fiscal :', String(new Date().getFullYear()));
    if (!yearText) return;
    const year = Number(yearText);
    if (!Number.isInteger(year) || year < 1990 || year > 2100) { window.alert('Exercice fiscal invalide.'); return; }
    try { await auth.createDossier(clientName.trim(), year); }
    catch (error) { window.alert(error instanceof Error ? error.message : 'Impossible de créer le dossier.'); }
  };
  const createWorkspace = async () => {
    const name = window.prompt('Nom du nouveau cabinet / espace de travail :');
    if (!name?.trim()) return;
    try { await auth.createWorkspace(name.trim()); }
    catch (error) { window.alert(error instanceof Error ? error.message : 'Impossible de créer le cabinet.'); }
  };
  const addMember = async () => {
    const email = window.prompt('E-mail d’un utilisateur déjà inscrit à Mizan :');
    if (!email?.trim()) return;
    const roleValue = window.prompt('Rôle dans ce cabinet : saisissez « auditeur » ou « client ».', 'auditeur');
    if (!roleValue) return;
    if (!['auditeur', 'client'].includes(roleValue.trim().toLowerCase())) { window.alert('Rôle invalide.'); return; }
    try { await auth.addWorkspaceMember(email.trim(), roleValue.trim().toLowerCase() as 'auditeur' | 'client'); window.alert('Membre ajouté au cabinet. Il pourra accéder aux dossiers de cet espace à sa prochaine connexion.'); }
    catch (error) { window.alert(error instanceof Error ? error.message : 'Impossible d’ajouter ce membre.'); }
  };
  return <div className="app-shell">
    <aside className="sidebar">
      <Link href="/" className="brand" data-testid="link-brand">
        <span className="brand-mark">م</span><span><span className="brand-name">Mizan</span><span className="brand-caption">Audit workspace · Maroc</span></span>
      </Link>
      <div className="nav-label">Espace de travail</div>
      <nav aria-label="Navigation principale">{navItems.map(item => { const Icon = item.icon; return <Link key={item.href} href={item.href} className={`nav-link ${location === item.href ? 'active' : ''}`} data-testid={`link-nav-${item.href.replace('/', '') || 'overview'}`}><Icon size={16} strokeWidth={1.7}/><span>{item.label}</span></Link>; })}</nav>
      <div className="sidebar-bottom"><strong>Exercice {auth.activeDossier?.exerciceAnnee || workspace.settings.fiscalYear}</strong><br/>Données persistées dans PostgreSQL.<br/><span>Session sécurisée · validation humaine requise</span></div>
    </aside>
    <div className="main-column">
      <header className="topbar"><div className="top-context"><Landmark size={14}/><span>Cabinet /</span><strong>{auth.activeWorkspace?.name || 'Espace de travail'}</strong></div>
        {auth.workspaces.length > 1 && <select aria-label="Cabinet actif" value={auth.activeWorkspaceId || ''} onChange={event=>auth.selectWorkspace(event.target.value)} className="top-select">{auth.workspaces.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}
        {auth.user.role !== 'client' && <button className="button small" onClick={()=>void createWorkspace()} title="Créer un cabinet"><Plus size={13}/> Nouveau cabinet</button>}
        {auth.activeWorkspace?.role === 'admin' && <button className="button small" onClick={()=>void addMember()} title="Ajouter un utilisateur déjà inscrit"><Plus size={13}/> Ajouter un membre</button>}
        <select aria-label="Dossier client actif" value={auth.activeDossierId || ''} onChange={event=>auth.selectDossier(event.target.value)} className="top-select dossier-select" disabled={!auth.dossiers.length}>{auth.dossiers.length ? auth.dossiers.map(item=><option key={item.id} value={item.id}>{item.clientName} · {item.exerciceAnnee}</option>) : <option value="">Aucun dossier</option>}</select>
        {auth.activeWorkspace?.role !== 'client' && <button className="button small" onClick={()=>void createDossier()} title="Créer un dossier client"><FolderPlus size={13}/> Nouveau dossier</button>}
        {workspace.datasets.length > 0 && <select aria-label="Source comptable analysée" value={activeDataset?.id || ''} onChange={event=>selectDataset(event.target.value)} data-testid="select-active-dataset" className="top-select source-select">{workspace.datasets.map(dataset=><option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select>}
        <div className="session-user"><span className="local-dot"/><span>{auth.user.name}</span><button className="icon-button" aria-label="Déconnexion" title="Déconnexion" onClick={()=>void auth.logout()}><LogOut size={14}/></button></div>
      </header>
      {loadingDossier && <div className="session-banner">Chargement du dossier et de ses imports persistants…</div>}
      {persistenceError && <div className="status-note" role="alert" data-testid="status-local-storage-error"><strong>Persistance :</strong> {persistenceError}</div>}
      <main className="content">{children}</main>
    </div>
  </div>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-head"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="subhead">{description}</p></div>{action}</div>;
}
function Stat({ label, value, foot, icon }: { label: string; value: string; foot: string; icon: ReactNode }) {
  return <section className="panel stat-card" data-testid={`stat-${label.toLowerCase().replaceAll(' ', '-')}`}><div className="stat-label"><span>{label}</span>{icon}</div><div className="stat-value">{value}</div><div className="stat-foot">{foot}</div></section>;
}
function EmptyState({ title, description, icon = <FileCheck2 size={17}/> }: { title: string; description: string; icon?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong><p>{description}</p></div>;
}
function Severity({ value }: { value: string }) { const label: Record<string, string> = { critical: 'Critique', high: 'Élevée', medium: 'À vérifier', low: 'Faible', info: 'Info' }; return <span className={`badge ${value}`}>{label[value] || value}</span>; }
function Notice({ children }: { children: ReactNode }) { return <div className="data-note">{children}</div>; }

function OverviewPage() {
  const { entries, findings, totalDebit, totalCredit, workspace, activeDataset } = useWorkspace();
  const open = findings.filter(item => item.status === 'open').length;
  return <Shell><PageHeading eyebrow="Dossier en cours · Maroc" title="Vue d’ensemble" description="Lecture rapide de votre périmètre comptable et des contrôles à examiner." action={<Link href="/import" className="button primary" data-testid="button-import-top"><Plus size={15}/> Importer un fichier</Link>}/>
    <div className="status-note"><strong>Avant toute décision.</strong> Mizan met en évidence des anomalies potentielles et propose des pistes de revue. Les résultats sont indicatifs, nécessitent une vérification humaine et ne constituent pas un conseil fiscal certifié.</div>
    <div className="stat-grid">
      <Stat label="Lignes comptables" value={formatNumber(entries.length)} foot={workspace.datasets.length ? `${workspace.datasets.length} fichier${workspace.datasets.length > 1 ? 's' : ''} dans le dossier` : 'Aucune donnée importée'} icon={<BookOpenCheck size={15}/>}/>
      <Stat label="Total débit" value={formatMad(totalDebit)} foot="Somme des lignes importées · MAD" icon={<ArrowDownToLine size={15}/>}/>
      <Stat label="Total crédit" value={formatMad(totalCredit)} foot="Somme des lignes importées · MAD" icon={<ArrowRight size={15}/>}/>
      <Stat label="À examiner" value={formatNumber(open)} foot="Constats calculés sur vos données" icon={<CircleAlert size={15}/>}/>
    </div>
    <div className="dashboard-grid">
      <section className="panel panel-pad">
        <div className="section-head"><div><h2>Équilibre des journaux</h2><small>Totaux calculés depuis les lignes importées</small></div><span className="badge">{entries.length ? 'Données persistantes' : 'En attente'}</span></div>
        {entries.length ? <><div className="form-row"><div><div className="stat-label">Débit</div><div className="stat-value">{formatMad(totalDebit)}</div></div><div><div className="stat-label">Crédit</div><div className="stat-value">{formatMad(totalCredit)}</div></div></div><div className="progress-track"><div className="progress-fill" style={{ width: `${Math.max(1, Math.min(100, (Math.min(totalDebit, totalCredit) / Math.max(totalDebit, totalCredit, 1)) * 100))}%` }}/></div><div className="section-head"><small>Écart arithmétique</small><strong className="mono">{formatMad(Math.abs(totalDebit - totalCredit))}</strong></div><Notice>Un écart peut provenir d’un périmètre incomplet ou d’un import partiel. Il ne confirme pas à lui seul une erreur comptable.</Notice></> : <EmptyState title="Votre dossier commence ici" description="Importez un journal, un grand livre ou une balance. Les indicateurs seront calculés uniquement à partir de vos fichiers." icon={<FileUp size={17}/>}/>}
      </section>
      <section className="panel panel-pad">
        <div className="section-head"><div><h2>Dernier import</h2><small>Journal des fichiers locaux</small></div><Link href="/import" className="button ghost small">Gérer <ArrowRight size={13}/></Link></div>
        {activeDataset ? <div><div style={{display:'flex',alignItems:'center',gap:11,margin:'18px 0'}}><div className="empty-icon"><FileSpreadsheet size={16}/></div><div><strong style={{fontSize:12}}>{activeDataset.name}</strong><div className="quiet">{formatNumber(activeDataset.entries.length)} lignes · {activeDataset.period}</div></div></div><div className="section-head"><small>Enregistré le</small><span className="mono" style={{fontSize:10}}>{shortDate(activeDataset.importedAt)}</span></div><Notice>Les données structurées sont conservées dans PostgreSQL pour ce dossier. Aucune ligne n’est envoyée à l’IA sans demande explicite.</Notice></div> : <EmptyState title="Aucun fichier importé" description="Commencez par charger un journal, un grand livre ou une balance en CSV, Excel ou PDF textuel."/>}
      </section>
    </div>
    <section className="panel" style={{marginTop:15}}>
      <div className="panel-pad"><div className="section-head"><div><h2>Constats récents</h2><small>Règles exécutées localement · zéro résultat fictif</small></div><Link href="/audit" className="button small">Ouvrir la revue <ArrowRight size={13}/></Link></div>
        {findings.length ? <div className="table-wrap"><table><thead><tr><th>Règle</th><th>Constat</th><th>Gravité</th><th>Montant à contrôler</th><th>État</th></tr></thead><tbody>{findings.slice(0,5).map(item=><tr key={item.id}><td className="mono">{item.ruleCode}</td><td>{item.title}</td><td><Severity value={item.severity}/></td><td className="mono">{formatMad(item.amount)}</td><td>{item.status === 'open' ? 'À examiner' : item.status === 'reviewed' ? 'Vérifié' : 'Écarté'}</td></tr>)}</tbody></table></div> : <EmptyState title={entries.length ? 'Aucun signal détecté par les règles disponibles' : 'Aucun constat pour le moment'} description={entries.length ? 'Cela ne vaut pas certification de conformité. Consultez le périmètre de contrôle et vos pièces justificatives.' : 'Les constats apparaîtront après l’import et l’analyse locale de vos écritures.'}/>}
      </div>
    </section>
    <div style={{marginTop:14}}><Notice><ShieldCheck size={13} style={{verticalAlign:'middle',marginRight:5}}/> Les montants sont présentés en dirhams marocains (MAD). Mizan fournit des indications de revue, pas une attestation ni un conseil fiscal certifié.</Notice></div>
  </Shell>;
}

const fields: { key: keyof ColumnMap; label: string; required?: boolean }[] = [
  { key: 'date', label: 'Date' }, { key: 'journal', label: 'Journal' }, { key: 'accountCode', label: 'Code compte' }, { key: 'accountLabel', label: 'Libellé compte' }, { key: 'reference', label: 'Référence' }, { key: 'description', label: 'Description' }, { key: 'debit', label: 'Débit MAD', required: true }, { key: 'credit', label: 'Crédit MAD', required: true },
];
function ImportPage() {
  const { importRows, workspace, entries, loadingDossier, readyDossierId } = useWorkspace();
  const auth = useAuth();
  const canEdit = auth.activeWorkspace?.role !== 'client';
  // The dossier must be loaded before an import can be attached to it.
  const dossierReady = Boolean(auth.activeDossierId) && readyDossierId === auth.activeDossierId;
  const importLock = useRef(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [map, setMap] = useState<ColumnMap>({ date:'',journal:'',accountCode:'',accountLabel:'',reference:'',description:'',debit:'',credit:'' });
  const [fileName, setFileName] = useState('');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [documentType, setDocumentType] = useState<Dataset['documentType']>('journal');
  const [period, setPeriod] = useState(String(workspace.settings.fiscalYear));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [drag, setDrag] = useState(false);
  const processFile = async (file?: File, sheetName?: string) => {
    if (!file) return;
    setMessage(''); setFileName(file.name);
    setSourceFile(file);
    setBusy(true);
    try {
      const parsed = await readAccountingFile(file, sheetName);
      setHeaders(parsed.headers);
      setRows(parsed.rows);
      setMap(guessColumnMap(parsed.headers));
      setSheets(parsed.sheets);
      setSelectedSheet(parsed.sheets.length ? sheetName || parsed.sheets[0] : '');
      if (!parsed.headers.length) setMessage('Le fichier semble vide ou son séparateur n’a pas pu être reconnu.');
      else if (parsed.format === 'PDF' && parsed.textBasedPdf) setMessage('Texte extrait localement du PDF. Vérifiez l’alignement et les colonnes dans l’aperçu avant de confirmer.');
    } catch (error) {
      setHeaders([]); setRows([]); setSheets([]);
      const reason = error instanceof Error ? error.message : '';
      const notices: Record<string, string> = {
        FILE_TOO_LARGE: 'Le fichier dépasse la limite de 100 Mo. Réduisez-le ou exportez seulement les lignes utiles.',
        FILE_TOO_MANY_ROWS: 'Le fichier dépasse la limite de lignes de cette version. Importez-le par période ou par feuille.',
        PDF_IMAGE_ONLY: 'Ce PDF semble être un scan sans texte sélectionnable. Il nécessite un OCR avant import ; aucune extraction hasardeuse n’a été effectuée.',
        EMPTY_WORKBOOK: 'Le classeur Excel ne contient aucune feuille exploitable.',
        UNSUPPORTED_FILE_TYPE: 'Format de fichier non pris en charge. Choisissez CSV, XLSX, XLS ou PDF.',
      };
      setMessage(notices[reason] || 'Impossible de lire ce fichier dans le navigateur. Vérifiez qu’il n’est pas endommagé ou protégé par mot de passe.');
    } finally {
      setBusy(false);
    }
  };
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    setSelectedSheet('');
    setSheets([]);
    void processFile(file);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDrag(false); processFile(event.dataTransfer.files[0]); };
  const importNow = async () => {
    // A `useState` flag is not a lock: two clicks inside one React batch both
    // read the pre-update value and both fire a request. The ref is read and
    // set synchronously, so the second click is dropped.
    if (importLock.current || busy) return;
    if (!map.debit || !map.credit || (documentType === 'balance' ? (!map.accountCode && !map.accountLabel) : !map.date)) {
      setMessage(documentType === 'balance' ? 'Pour une balance, associez au minimum un compte, un débit et un crédit.' : 'Associez au minimum les colonnes Date, Débit et Crédit avant de poursuivre.');
      return;
    }
    importLock.current = true;
    setImporting(true);
    setMessage(`Enregistrement de ${formatNumber(rows.length)} lignes dans PostgreSQL…`);
    try {
      const outcome = await importRows(fileName, rows, map, period, documentType, headers);
      if (outcome.ok) {
        setMessage(`${formatNumber(outcome.rowCount)} lignes enregistrées dans PostgreSQL.`);
        setRows([]); setHeaders([]);
      } else {
        // The hook always names its own cause; show it where the click happened.
        setMessage(`L’import n’a pas abouti : ${outcome.error}`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? `Échec de l’import : ${error.message}` : 'Échec inattendu pendant l’import.');
    } finally {
      // Runs on every path, including a thrown error, so the button can never
      // stay stuck on "Enregistrement…".
      importLock.current = false;
      setImporting(false);
    }
  };
  return <Shell><PageHeading eyebrow="Données persistantes" title="Importer un fichier" description="Prévisualisez vos colonnes, associez-les au format attendu et confirmez l’ajout à l’espace de travail."/>
    <div className="page-grid">
      <div>
        <div className={`dropzone ${drag ? 'drag' : ''}`} onDragOver={event=>{event.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={onDrop} data-testid="dropzone-import">
          <FileUp size={23} color="hsl(var(--primary))"/><h3>Déposez un fichier comptable ici</h3><p>CSV, XLSX ou PDF · les données seront enregistrées dans PostgreSQL</p>
          <label className={`button primary ${!canEdit ? 'disabled' : ''}`} htmlFor="local-file"><FileUp size={14}/> Parcourir les fichiers</label><input id="local-file" data-testid="input-import-file" type="file" accept=".csv,.txt,.xlsx,.xls,.pdf" onChange={onFile} disabled={!canEdit} style={{display:'none'}}/>
        </div>
        {message && <div className="status-note" role="status" style={{marginTop:12}}>{message}</div>}
        {busy && <div className="panel panel-pad" style={{marginTop:14}}><div className="eyebrow">Lecture locale</div><div className="progress-track"><div className="progress-fill" style={{width:'62%'}}/></div><small className="quiet">Préparation de l’aperçu…</small></div>}
        {headers.length > 0 && <section className="panel panel-pad" style={{marginTop:14}}>
          <div className="section-head"><div><h2>Associer les colonnes</h2><small>{fileName} · {formatNumber(rows.length)} lignes repérées</small></div><span className="badge reviewed">Aperçu local</span></div>
          <div className="form-row" style={{marginBottom:14}}><div className="field"><label htmlFor="period">Exercice / période</label><input id="period" value={period} onChange={event=>setPeriod(event.target.value)} data-testid="input-import-period"/></div><div className="field"><label htmlFor="document-type">Nature du document</label><select id="document-type" value={documentType} onChange={event=>setDocumentType(event.target.value as Dataset['documentType'])} data-testid="select-document-type"><option value="journal">Journal</option><option value="grand_livre">Grand livre</option><option value="balance">Balance</option><option value="autre">Autre extrait</option></select></div><div className="field"><label>Fichier source</label><input readOnly value={fileName}/></div></div>
          <div className="quiet" style={{marginBottom:12}}>Les fichiers sont analysés séparément : sélectionner une source à la fois évite de doubler les écritures d’un journal, d’un grand livre et d’une balance.</div>
          {sheets.length > 1 && <div className="field" style={{marginBottom:14}}><label htmlFor="workbook-sheet">Feuille Excel</label><select id="workbook-sheet" value={selectedSheet} onChange={event=>{setSelectedSheet(event.target.value);void processFile(sourceFile || undefined,event.target.value);}} data-testid="select-workbook-sheet">{sheets.map(sheet=><option key={sheet} value={sheet}>{sheet}</option>)}</select></div>}
          <div className="mapping-grid">{fields.map(field=>{const required=field.required||(field.key==='date'&&documentType!=='balance');return <div className="field" key={field.key}><label htmlFor={`map-${field.key}`}>{field.label}{required?' *':''}</label><select id={`map-${field.key}`} value={map[field.key]} onChange={event=>setMap(current=>({...current,[field.key]:event.target.value}))} data-testid={`select-map-${field.key}`}><option value="">— Non associé —</option>{headers.map((header,index)=><option key={`${header}-${index}`} value={String(index)}>{header || `Colonne ${index+1}`}</option>)}</select></div>;})}</div>
          <div className="section-head" style={{marginTop:23}}><h3>Aperçu des premières lignes</h3><small>Rien n’est envoyé à la base avant votre confirmation</small></div>
          <div className="table-wrap"><table><thead><tr>{headers.map((head,index)=><th key={`${head}-${index}`}>{head || `Col. ${index+1}`}</th>)}</tr></thead><tbody>{rows.slice(0,5).map((row,index)=><tr key={index}>{headers.map((_,col)=><td key={col}>{row[col] || '—'}</td>)}</tr>)}</tbody></table></div>
          <div style={{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:10,marginTop:17}}>
            {!auth.activeDossierId && <span className="quiet">Sélectionnez un dossier client avant de confirmer.</span>}
            {auth.activeDossierId && !dossierReady && <span className="quiet">{loadingDossier ? 'Chargement du dossier…' : 'Le dossier n’est pas chargé. Vérifiez le message « Persistance » en haut de la page.'}</span>}
            <button className="button primary" onClick={importNow} disabled={!canEdit || busy || importing || !dossierReady} data-testid="button-confirm-import">{importing ? <><RotateCcw size={14} className="spin"/> Enregistrement…</> : <><Check size={14}/> Confirmer l’importation</>}</button>
          </div>
        </section>}
        <section className="panel" style={{marginTop:14}}><div className="panel-pad"><div className="section-head"><div><h2>Sources importées</h2><small>{workspace.datasets.length} fichier(s) · {formatNumber(entries.length)} lignes</small></div><Database size={16} color="hsl(var(--muted-foreground))"/></div>
          {workspace.datasets.length ? <div className="table-wrap"><table><thead><tr><th>Fichier</th><th>Document</th><th>Format</th><th>Période</th><th>Lignes</th><th>Enregistré le</th></tr></thead><tbody>{workspace.datasets.map((dataset: Dataset)=><tr key={dataset.id}><td>{dataset.name}</td><td>{dataset.documentType === 'grand_livre' ? 'Grand livre' : dataset.documentType === 'balance' ? 'Balance' : dataset.documentType === 'journal' ? 'Journal' : 'Autre'}</td><td>{dataset.type}</td><td>{dataset.period}</td><td className="mono">{dataset.entries.length}</td><td>{shortDate(dataset.importedAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="Votre espace est vide" description="Les fichiers importés apparaîtront ici après confirmation."/>}
        </div></section>
      </div>
      <aside>
        <section className="panel panel-pad"><div className="section-head"><h3><ShieldCheck size={15} style={{verticalAlign:'middle',marginRight:6}}/>Traitement confidentiel</h3></div><p className="subhead" style={{fontSize:11}}>Le fichier est lu dans le navigateur pour permettre l’aperçu et l’association des colonnes. Après confirmation, les lignes structurées et les références du fichier sont enregistrées dans PostgreSQL pour le dossier actif.</p><div style={{marginTop:14}}><Notice>Les PDF scannés sans texte sélectionnable nécessitent un OCR préalable. Contrôlez toujours l’aperçu, surtout pour les cellules alignées dans un PDF.</Notice></div></section>
        <section className="panel panel-pad" style={{marginTop:12}}><div className="eyebrow">Format reconnu</div><h3>Colonnes usuelles</h3><div style={{display:'grid',gap:9,marginTop:14}}>{fields.map(item=>{const required=item.required||(item.key==='date'&&documentType!=='balance');const alternative=documentType==='balance'&&(item.key==='accountCode'||item.key==='accountLabel');return <div key={item.key} style={{display:'flex',justifyContent:'space-between',fontSize:10}}><span>{item.label}</span><span className="quiet">{alternative?'Compte requis (au choix)':required?'Requis':'Facultatif'}</span></div>;})}</div></section>
      </aside>
    </div>
  </Shell>;
}

function ProposalCard({ proposal, finding }: { proposal: Proposal; finding?: AuditFinding }) {
  const { updateProposal, workspace } = useWorkspace();
  const auth = useAuth();
  const canEdit = auth.activeWorkspace?.role !== 'client';
  const sourceRows = workspace.datasets.flatMap(dataset=>dataset.entries).filter(entry=>proposal.lines.includes(entry.id)).map(entry=>`${entry.sourceFile} · ligne ${entry.sourceRow}`);
  const accepted = proposal.status === 'accepted';
  return <div className="proposal">
    <strong>Proposition de correction <span className={`badge ${accepted ? 'reviewed' : ''}`}>{proposal.status === 'proposed' ? 'PROPOSITION' : accepted ? 'Appliquée au dossier' : 'Refusée'}</span></strong>
    <div>{proposal.description}</div>
    {typeof proposal.confidence === 'string' && <div className="quiet" style={{marginTop:5}}>Confiance indicative : {proposal.confidence}. Cette estimation n’est pas une mesure certifiée.</div>}
    {proposal.journalEntry?.length ? <div className="table-wrap" style={{marginTop:10}}><table><thead><tr><th>Compte</th><th>Libellé</th><th>Débit MAD</th><th>Crédit MAD</th><th>Justification</th></tr></thead><tbody>{proposal.journalEntry.map((line,index)=><tr key={`${line.accountCode}-${index}`}><td className="mono">{line.accountCode || '—'}</td><td>{line.accountLabel || '—'}</td><td className="mono">{formatNumber(line.debit)}</td><td className="mono">{formatNumber(line.credit)}</td><td style={{whiteSpace:'normal',minWidth:160}}>{line.rationale}</td></tr>)}</tbody></table></div> : null}
    {proposal.prerequisites?.length ? <div style={{marginTop:9}}><strong>Vérifications préalables</strong><ul className="proposal-list">{proposal.prerequisites.map((item,index)=><li key={index}>{item}</li>)}</ul></div> : null}
    <div className="quiet" style={{marginTop:7}}>Lignes sources : {sourceRows.length ? sourceRows.join(' ; ') : '—'}. Les lignes originales restent intactes ; l’accord est consigné dans le dossier de travail.</div>
    {proposal.status === 'proposed' && canEdit && <div className="finding-actions"><button className="button small primary" onClick={()=>{if(window.confirm('Confirmer cette proposition et la consigner comme écriture de régularisation dans le dossier de travail ? Les données sources originales resteront inchangées.')) updateProposal(proposal,'accepted');}} data-testid={`button-proposal-accept-${proposal.id}`}><Check size={12}/> Confirmer et Appliquer</button><button className="button small" onClick={()=>updateProposal(proposal,'rejected')} data-testid={`button-proposal-reject-${proposal.id}`}><X size={12}/> Refuser</button></div>}
    {accepted && <div className="data-note" style={{marginTop:9}}>Proposition confirmée le {proposal.appliedAt ? shortDate(proposal.appliedAt) : '—'}. Elle est enregistrée comme correction validée au dossier ; l’écriture comptable source n’est pas réécrite.</div>}
    {finding && <span className="quiet" style={{display:'none'}}>{finding.title}</span>}
  </div>;
}
function OriginBadge({ finding }: { finding: AuditFinding }) {
  if (finding.origin === 'semantic') return <span className="badge ai" title="Prédiction du Niveau 2, à vérifier"><Cpu size={11}/> Niveau 2 · IA · confiance {finding.confidence || 'faible'}</span>;
  return finding.mergedSemantic?.length
    ? <span className="badge ai" title="Analyse IA de Niveau 2 acceptée et fusionnée dans ce constat"><Cpu size={11}/> + {finding.mergedSemantic.map(item=>item.ruleCode).join(', ')} fusionné</span>
    : null;
}
/** Label of the accept button: folding into a Level 1 constat (case A) or adding a new one (case B). */
function acceptLabel(item: { level1?: AuditFinding | null }) {
  return item.level1 ? `Accepter & fusionner dans ${item.level1.ruleCode}` : 'Accepter & ajouter au dossier de travail';
}
function decisionLabel(item: SemanticItem & { level1?: AuditFinding | null }) {
  if (item.decision === 'merged') return item.level1 ? `Fusionné dans ${item.level1.ruleCode} (Niveau 1)` : 'Ajouté au dossier (Niveau 2 IA)';
  return DECISION_LABELS[item.decision];
}
function FindingCard({ finding: listed, onClose, pendingItem }: { finding: AuditFinding; onClose: () => void; pendingItem?: SemanticItem & { level1?: AuditFinding | null } }) {
  const { workspace, entries, activeDataset, findings, setFindingStatus, propose, updateProposalWithAi, decideSemantic } = useWorkspace();
  // A Level 1 constat is shown as it stands in the working file, with any folded AI analysis.
  const finding = findings.find(item=>item.id===listed.id) || listed;
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canEdit = auth.activeWorkspace?.role !== 'client';
  const [sourceOpen,setSourceOpen] = useState(true);
  const [aiBusy,setAiBusy] = useState(false);
  const [aiError,setAiError] = useState('');
  const proposal = workspace.proposals.find(item=>item.findingId===finding.id);
  const sourceEntries = entries.filter(entry=>finding.sourceRowIds.includes(entry.id));
  const references = [...new Set(sourceEntries.map(entry=>entry.reference.trim()).filter(Boolean))];
  const sourceLocations = sourceEntries.slice(0,5).map(entry=>`${entry.sourceFile} · ligne ${entry.sourceRow}`);
  const extraLocations = Math.max(0,sourceEntries.length-sourceLocations.length);
  const generateAiCorrection = async () => {
    if (!window.confirm('La génération IA enverra à Groq le constat sélectionné et les lignes comptables sources associées (comptes, libellés, pièces, débit et crédit). Confirmez-vous cet envoi ?')) return;
    setAiBusy(true); setAiError('');
    try {
      // A model call is slow but must still be bounded; apiJson raises a
      // readable ApiError on timeout instead of leaving the button spinning.
      const result = await apiJson<{description?:string;journalEntry?:{accountCode:string;accountLabel:string;debit:number;credit:number;rationale:string}[];prerequisites?:string[];confidence?:'faible'|'moyenne'|'élevée';disclaimer?:string}>('/api/audit/ai-correction', {
        method:'POST',
        ...jsonBody({
          finding:{ruleCode:finding.ruleCode,severity:finding.severity,title:finding.title,explanation:finding.explanation,amount:finding.amount,suggestion:finding.suggestion},
          sourceRows:sourceEntries.slice(0,50).map(entry=>({date:entry.date,accountCode:entry.accountCode,accountLabel:entry.accountLabel,reference:entry.reference,description:entry.description,debit:entry.debit,credit:entry.credit})),
        }),
        timeoutMs: AI_TIMEOUT_MS,
      });
      updateProposalWithAi(finding,{
        description: result.description || 'L’IA n’a pas fourni de description exploitable ; vérification manuelle nécessaire.',
        journalEntry: Array.isArray(result.journalEntry) ? result.journalEntry : [],
        prerequisites: [...(Array.isArray(result.prerequisites)?result.prerequisites:[]), ...(result.disclaimer?[result.disclaimer]:[])],
        confidence: result.confidence || 'faible',
      });
    } catch(error) { setAiError(errorMessage(error, 'Impossible de générer une correction IA.')); }
    finally { setAiBusy(false); void queryClient.invalidateQueries({ queryKey: AI_USAGE_KEY }); }
  };
  return <article className="finding finding-detail" data-testid={`finding-${finding.id}`}>
    <div className="finding-top"><div><div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}><span className="mono quiet">{finding.ruleCode}</span><Severity value={finding.severity}/><OriginBadge finding={finding}/>{pendingItem && <span className="badge medium">Prédiction en attente</span>}{finding.status === 'reviewed' && <span className="badge reviewed"><BadgeCheck size={11}/> Vérifié</span>}{finding.status === 'dismissed' && <span className="badge">Écarté</span>}</div><h3 className="finding-title" style={{marginTop:9}}>{finding.title}</h3><p className="finding-desc">{finding.explanation}</p></div><strong className="mono" style={{fontSize:12,whiteSpace:'nowrap'}}>{formatMad(finding.amount)}</strong></div>
    <div className="finding-meta"><span>{finding.sourceRowIds.length} ligne(s) · pièce(s) {references.length?references.slice(0,5).join(', '):'non renseignée(s)'}</span><span>{sourceLocations.join(' ; ')}{extraLocations?` ; +${extraLocations} ligne(s)`:''}</span></div>
    <div className="source-toolbar"><div><strong><FileSpreadsheet size={14}/> Document source</strong><small>{activeDataset?.name || 'Aucun fichier'} · lignes et cellules associées au constat</small></div><button className="button small" onClick={()=>setSourceOpen(value=>!value)}>{sourceOpen?'Masquer la grille':'Afficher la grille'} <ChevronDown size={12}/></button></div>
    {sourceOpen && <div className="source-viewer"><div className="source-ribbon"><span><Eye size={12}/> {sourceEntries.length} ligne(s) concernée(s)</span><span>Cellules clés surlignées · fichier source non modifié</span></div>
      {activeDataset?.headers?.length ? <div className="table-wrap source-table"><table><thead><tr><th>Ligne source</th>{activeDataset.headers.map((head,index)=><th key={`${head}-${index}`}>{head || `Colonne ${index+1}`}</th>)}</tr></thead><tbody>
        {sourceEntries.slice(0,50).map(entry=>{
          const row=activeDataset?.sourceRows?.[entry.sourceRow-2] || [];
          const keyColumns=activeDataset ? highlightedSourceColumns(finding, activeDataset, entry) : [];
          return <tr className="source-row-active" key={entry.id}><th className="mono">{entry.sourceRow}</th>{activeDataset!.headers.map((_,col)=><td key={col} className={keyColumns.includes(col)?'source-cell-highlight':''} aria-label={keyColumns.includes(col)?`Cellule concernée: ligne ${entry.sourceRow}, colonne ${activeDataset!.headers[col] || col+1}`:undefined}>{row[col] || '—'}</td>)}</tr>;
        })}
      </tbody></table></div> : <div className="table-wrap"><table><thead><tr><th>Ligne</th><th>Compte</th><th>Libellé</th><th>Pièce</th><th>Débit</th><th>Crédit</th></tr></thead><tbody>{sourceEntries.map(entry=><tr key={entry.id} className="source-row-active"><td>{entry.sourceRow}</td><td>{entry.accountCode}</td><td>{entry.accountLabel || entry.description}</td><td>{entry.reference}</td><td>{formatNumber(entry.debit)}</td><td>{formatNumber(entry.credit)}</td></tr>)}</tbody></table></div>}
      {sourceEntries.length>50 && <p className="quiet" style={{padding:10}}>50 premières lignes affichées pour ce constat. Exportez le dossier pour examiner l’ensemble des données.</p>}
    </div>}
    {proposal && <ProposalCard proposal={proposal} finding={finding}/>}
    {pendingItem ? <div className="finding-actions finding-actions-wrap">
      {pendingItem.decision === 'pending' && pendingItem.level1 && <span className="quiet" style={{flexBasis:'100%'}}>Même pièce / ligne que le constat Niveau 1 <strong className="mono">{pendingItem.level1.ruleCode}</strong> « {pendingItem.level1.title} » : l’accepter enrichira ce constat sans créer de doublon.</span>}
      {canEdit && pendingItem.decision === 'pending' && <><button className="button small primary" onClick={()=>decideSemantic(pendingItem,'merged')} data-testid={`button-semantic-merge-detail-${finding.id}`}><Check size={12}/> {acceptLabel(pendingItem)}</button><button className="button small ghost" onClick={()=>decideSemantic(pendingItem,'rejected')}><X size={12}/> Rejeter / écarter l’anomalie</button></>}
      {pendingItem.decision === 'rejected' && <span className="quiet">Prédiction rejetée : elle n’entre pas dans le dossier de travail.</span>}
      <button className="button small ghost" onClick={onClose}><PanelRightClose size={12}/> Fermer</button>
    </div> : <div className="finding-actions finding-actions-wrap">
      {canEdit && <><button className="button small primary" onClick={()=>void generateAiCorrection()} disabled={aiBusy} data-testid={`button-ai-correction-${finding.id}`}><Sparkles size={12}/>{aiBusy?'Génération…':'Générer la correction IA'}</button>
      {!proposal && <button className="button small" onClick={()=>propose(finding)} data-testid={`button-propose-${finding.id}`}><Plus size={12}/> Proposition manuelle</button>}
      {finding.status === 'open' && <><button className="button small" onClick={()=>setFindingStatus(finding,'reviewed')} data-testid={`button-review-${finding.id}`}><Check size={12}/> Marquer vérifié</button><button className="button small ghost" onClick={()=>setFindingStatus(finding,'dismissed')} data-testid={`button-dismiss-${finding.id}`}><X size={12}/> Écarter</button></>}</>}
      {!canEdit && <span className="quiet">Lecture seule : contactez le cabinet pour modifier ce constat.</span>}
      <button className="button small ghost" onClick={onClose}><PanelRightClose size={12}/> Fermer</button>
    </div>}
    {aiError && <div className="status-note" role="alert" style={{marginTop:10}}>{aiError}</div>}
  </article>;
}
type SemanticBatchResult = { findings: SemanticPrediction[]; coverageNote: string; discarded: number; analysedRows: number };
const MAX_RATE_LIMIT_WAITS = 3;
function SemanticRunPanel() {
  const { entries, activeDataset, workspace, addSemanticPredictions, clearPendingSemantic } = useWorkspace();
  const auth = useAuth();
  const canEdit = auth.activeWorkspace?.role !== 'client';
  const queryClient = useQueryClient();
  const [consent, setConsent] = useState(false);
  // -1 reads the whole journal; a positive value a window of SEMANTIC_SCOPE_ROWS rows.
  const [scope, setScope] = useState(-1);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, waiting: 0 });
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const cancelled = useRef(false);
  const windows = Math.ceil(entries.length / SEMANTIC_SCOPE_ROWS);
  useEffect(() => { setScope(-1); setSummary(''); setError(''); cancelled.current = true; }, [activeDataset?.id]);
  const wait = async (seconds: number) => {
    for (let left = seconds; left > 0 && !cancelled.current; left -= 1) {
      setProgress(current => ({ ...current, waiting: left }));
      await new Promise(resolve => window.setTimeout(resolve, 1000));
    }
    setProgress(current => ({ ...current, waiting: 0 }));
  };
  const run = async () => {
    if (!consent || !activeDataset || running) return;
    const datasetId = activeDataset.id;
    const datasetEntries = entries;
    // Level 2 reads every row of the scope, including those Level 1 already flagged, so both can be compared.
    const start = scope < 0 ? 0 : scope * SEMANTIC_SCOPE_ROWS;
    const end = scope < 0 ? datasetEntries.length : start + SEMANTIC_SCOPE_ROWS;
    const indices = datasetEntries.slice(start, end).map((_, offset) => start + offset);
    const batches = buildSemanticBatches(datasetEntries, indices);
    cancelled.current = false;
    setRunning(true); setError(''); setSummary('');
    setProgress({ done: 0, total: batches.length, waiting: 0 });
    let added = 0, predicted = 0, discarded = 0, analysed = 0;
    const notes: string[] = [];
    try {
      for (const [position, batch] of batches.entries()) {
        let waits = 0;
        let retriedUnavailable = false;
        while (!cancelled.current) {
          try {
            const result = await apiJson<SemanticBatchResult>('/api/audit/semantic-review', {
              method: 'POST',
              ...jsonBody({ fiscalYear: workspace.settings.fiscalYear, rows: batch.map(index => semanticRowPayload(datasetEntries[index], index)) }),
              timeoutMs: AI_TIMEOUT_MS,
            });
            predicted += result.findings.length; discarded += result.discarded; analysed += result.analysedRows;
            added += addSemanticPredictions(datasetId, result.findings, datasetEntries);
            if (result.coverageNote) notes.push(result.coverageNote);
            break;
          } catch (failure) {
            // Groq's free plan allows 8,000 tokens per minute: wait as asked, then resume the same batch.
            if (failure instanceof ApiError && failure.status === 429 && waits < MAX_RATE_LIMIT_WAITS) {
              waits += 1;
              await wait(Math.min(90, failure.retryAfterSeconds || 60));
              continue;
            }
            // An unreadable or failed model answer is usually transient: the batch gets one more try.
            if (failure instanceof ApiError && failure.status === 503 && !retriedUnavailable) {
              retriedUnavailable = true;
              await wait(5);
              continue;
            }
            throw failure;
          } finally {
            void queryClient.invalidateQueries({ queryKey: AI_USAGE_KEY });
          }
        }
        if (cancelled.current) break;
        setProgress(current => ({ ...current, done: position + 1 }));
      }
      setSummary(`${cancelled.current ? 'Analyse interrompue. ' : ''}${formatNumber(analysed)} ligne(s) lue(s) · ${predicted} prédiction(s) validée(s) par le serveur, dont ${added} nouvelle(s)${discarded ? ` · ${discarded} réponse(s) IA écartée(s) car invérifiables` : ''}.${notes.length ? ` Note de l’IA : ${notes[0]}` : ''}`);
    } catch (failure) {
      setError(`${errorMessage(failure, 'L’analyse IA n’a pas abouti.')} Les prédictions déjà reçues sont conservées.`);
    } finally {
      setRunning(false);
    }
  };
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return <div className="panel-pad semantic-run">
    <div className="section-head"><div><div className="eyebrow">Niveau 2 · lecture sémantique par IA</div><h2>Lancer l’analyse IA du journal</h2><small>Analyse autonome de toutes les lignes, y compris celles déjà relevées par le Niveau 1, pour comparer les deux restitutions : doublons flous (pièces « -BIS », « v2 », libellés proches à ± 5 jours), immobilisations passées en charge, rattachement à l’exercice, charges non déductibles, incohérences de TVA, libellés et tiers incohérents.</small></div><Cpu size={17} color="hsl(var(--primary))"/></div>
    <label className="consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} disabled={running} data-testid="checkbox-semantic-consent"/><span>Je consens à transmettre à l’API Groq les lignes détaillées du périmètre choisi : date, numéro et libellé de compte, référence de pièce, libellé d’écriture, débit et crédit. Le nom du fichier, du client et du dossier ne sont pas envoyés. Je dispose de l’autorisation du client pour ce traitement ; l’usage est décompté sur le compte Groq de la clé configurée.</span></label>
    <div className="semantic-controls">
      <div className="field"><label htmlFor="semantic-scope">Périmètre analysé</label><select id="semantic-scope" value={scope} onChange={event=>setScope(Number(event.target.value))} disabled={running || !entries.length} data-testid="select-semantic-scope"><option value={-1}>Journal complet · {formatNumber(entries.length)} lignes (≈ {formatNumber(Math.ceil(entries.length/SEMANTIC_BATCH_ROWS))} lots)</option>{windows > 1 && Array.from({ length: Math.max(1, windows) }, (_, index) => <option key={index} value={index}>Lignes {formatNumber(index*SEMANTIC_SCOPE_ROWS+1)} à {formatNumber(Math.min(entries.length,(index+1)*SEMANTIC_SCOPE_ROWS))}</option>)}</select></div>
      {!running ? <button className="button primary" onClick={()=>void run()} disabled={!canEdit || !consent || !entries.length} data-testid="button-semantic-run"><Sparkles size={14}/> Lancer le Niveau 2</button>
        : <button className="button" onClick={()=>{cancelled.current = true;}} data-testid="button-semantic-cancel"><X size={14}/> Interrompre</button>}
      {semanticPendingCount(workspace.semantic, activeDataset?.id) > 0 && !running && <button className="button small ghost" onClick={()=>activeDataset && clearPendingSemantic(activeDataset.id)}><Trash2 size={12}/> Effacer les prédictions en attente</button>}
    </div>
    <div className="quiet">Lots de 50 lignes au plus, regroupées par pièce ; les pièces susceptibles d’être des doublons (même numéro à un suffixe près, même montant à ± 5 jours) sont placées dans le même lot. Sur un long journal, l’analyse complète peut prendre plusieurs minutes et peut être interrompue à tout moment. Plan gratuit Groq : 8 000 tokens par minute, donc une pause peut s’intercaler entre deux lots ; elle est gérée automatiquement.</div>
    {(running || progress.total > 0) && <div className="semantic-progress"><div className="progress-track"><div className="progress-fill" style={{width:`${Math.max(2, percent)}%`}}/></div><small className="quiet">{running ? (progress.waiting ? `Limite Groq par minute atteinte : reprise dans ${progress.waiting} s (lot ${progress.done+1}/${progress.total})` : `Lot ${Math.min(progress.done+1, progress.total)}/${progress.total} en cours d’analyse…`) : `${progress.done}/${progress.total} lot(s) analysé(s)`}</small></div>}
    {summary && <div className="data-note" role="status">{summary}</div>}
    {error && <div className="status-note" role="alert">{error}</div>}
  </div>;
}
function semanticPendingCount(items: SemanticItem[], datasetId?: string) { return items.filter(item=>item.datasetId===datasetId && item.decision==='pending').length; }
const DECISION_LABELS: Record<SemanticItem['decision'], string> = { pending: 'En attente', merged: 'Fusionné au dossier', rejected: 'Rejeté' };

function ReviewPage() {
  const { findings, deterministicFindings, semanticItems, decideSemantic, entries, totalDebit, totalCredit, workspace, activeDataset, loadingDossier } = useWorkspace();
  const auth = useAuth();
  const canEdit = auth.activeWorkspace?.role !== 'client';
  const queryClient = useQueryClient();
  const [level, setLevel] = useState<'level1' | 'level2'>('level1');
  const [severity, setSeverity] = useState('Tous');
  const [status, setStatus] = useState('Tous');
  const [search, setSearch] = useState('');
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const detailPaneRef = useRef<HTMLElement>(null);
  // Below 1600px the detail pane stacks under the whole findings table, so
  // without scrolling to it a click on "Détail & source" looks like a no-op.
  useEffect(()=>{ if (selectedFindingId) detailPaneRef.current?.scrollIntoView({behavior:'smooth',block:'nearest'}); },[selectedFindingId]);
  const [consent, setConsent] = useState(false);
  const ai = useReviewAuditWithAi();
  const [aiError, setAiError] = useState('');
  useEffect(()=>{ai.reset();setAiError('');},[activeDataset?.id]);
  // Each tab filters its own list: Level 1 rules, or Level 2 predictions whatever their decision.
  const listSource = level === 'level1' ? deterministicFindings : semanticItems.map(item => item.finding);
  const semanticById = new Map(semanticItems.map(item => [item.finding.id, item]));
  const findingsById = new Map(findings.map(item => [item.id, item]));
  const filtered = listSource.filter(item => (severity==='Tous'||item.severity===severity) && (status==='Tous'||(status==='À examiner'?item.status==='open':status==='Vérifiés'?item.status==='reviewed':item.status==='dismissed')) && `${item.ruleCode} ${item.title} ${item.explanation}`.toLowerCase().includes(search.toLowerCase()));
  const digest = useMemo(() => {
    const groups = new Map<string,{ruleCode:string;severity:AuditFinding['severity'];occurrences:number}>();
    deterministicFindings.forEach(item=>{const key=`${item.ruleCode}-${item.severity}`;const current=groups.get(key)||{ruleCode:item.ruleCode,severity:item.severity,occurrences:0};current.occurrences+=1;groups.set(key,current);});
    return [...groups.values()].slice(0,40);
  }, [deterministicFindings]);
  const requestReview = () => {
    if (!consent || !entries.length) return;
    setAiError('');
    ai.mutate({ data: { fiscalYear: Number(workspace.settings.fiscalYear), summary: { entryCount: entries.length, totalDebit, totalCredit, balanceDifference: totalDebit-totalCredit, findingsCount: deterministicFindings.length }, findings: digest } }, { onSettled: () => void queryClient.invalidateQueries({ queryKey: AI_USAGE_KEY }), onError: error => {
      const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
      setAiError(status === 429
        ? 'La limite de revues IA est atteinte pour le moment. Les contrôles locaux restent accessibles.'
        : status === 503
          ? 'Le service IA est indisponible. Vérifiez que la clé Groq (GROQ_API_KEY) est configurée dans les Secrets du projet.'
          : 'La revue IA n’a pas abouti. Vérifiez votre connexion ou poursuivez la vérification locale.');
    } });
  };
  const semanticTable = <div className="table-wrap findings-table-wrap"><table className="findings-table"><thead><tr><th>Code IA & sévérité</th><th>Pièce / ligne source</th><th>Montant MAD</th><th>Explication de l’IA</th><th>Confiance</th><th>Décision & actions</th></tr></thead><tbody>{filtered.map(finding=>{
    const item=semanticById.get(finding.id);
    if(!item) return null;
    const source=entries.filter(entry=>finding.sourceRowIds.includes(entry.id));
    const sourceLabel=source.slice(0,3).map(entry=>`${entry.reference || 'Pièce —'} · ligne ${entry.sourceRow}`).join(' ; ')+(source.length>3?` · +${source.length-3}`:'');
    const select=(event: { stopPropagation: () => void })=>{event.stopPropagation();setSelectedFindingId(finding.id);};
    return <tr key={finding.id} className={`${selectedFindingId===finding.id?'selected-finding-row':''} ${item.decision==='rejected'?'semantic-rejected':''}`} onClick={()=>setSelectedFindingId(finding.id)} tabIndex={0} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setSelectedFindingId(finding.id);}}} data-testid={`semantic-row-${finding.id}`}>
      <td><strong className="mono">{finding.ruleCode}</strong><div style={{marginTop:5}}><Severity value={finding.severity}/></div></td>
      <td style={{whiteSpace:'normal',minWidth:150}}><span>{sourceLabel || 'Référence non renseignée'}</span><div className="quiet">{source[0]?.sourceFile || activeDataset?.name || '—'}</div></td>
      <td className="mono">{formatMad(finding.amount)}</td>
      <td className="finding-cell-copy">{finding.title}<small>{finding.explanation}</small></td>
      <td><span className={`badge ${finding.confidence==='élevée'?'reviewed':finding.confidence==='moyenne'?'medium':''}`}>{finding.confidence || 'faible'}</span></td>
      <td><span className={`badge ${item.decision==='merged'?'reviewed':item.decision==='pending'?'medium':''}`}>{decisionLabel(item)}</span>{item.decision==='merged'&&finding.status!=='open'&&<div className="quiet" style={{marginTop:4}}>{finding.status==='reviewed'?'Vérifié':'Écarté ensuite'}</div>}
        {item.decision==='pending' && <div className="quiet" style={{marginTop:4}} data-testid={`semantic-overlap-${finding.id}`}>{item.level1 ? <>Recoupe le Niveau 1 : <strong className="mono">{item.level1.ruleCode}</strong></> : 'Nouvelle anomalie (absente du Niveau 1)'}</div>}
        <div className="semantic-actions">
          {canEdit && item.decision==='pending' && <><button className="button small primary" onClick={event=>{event.stopPropagation();decideSemantic(item,'merged');}} data-testid={`button-semantic-merge-${finding.id}`}><Check size={12}/> {acceptLabel(item)}</button><button className="button small ghost" onClick={event=>{event.stopPropagation();decideSemantic(item,'rejected');}} data-testid={`button-semantic-reject-${finding.id}`}><X size={12}/> Rejeter / écarter</button></>}
          <button className="button small" onClick={select}><Eye size={12}/> Détail & source</button>
        </div></td>
    </tr>;
  })}</tbody></table></div>;
  const reviewed = findings.filter(item=>item.status==='reviewed').length;
  const exportRegister = () => {
    const escape=(value:string)=>`"${value.replaceAll('"','""')}"`;
    const allEntries=workspace.datasets.flatMap(dataset=>dataset.entries);
    const lines=[['Code règle','État','Fichier source','Lignes sources','Action proposée'].map(escape).join(';')];
    for(const proposal of workspace.proposals){
      const code=workspace.datasets.flatMap(dataset=>dataset.entries).length ? (findings.find(item=>item.id===proposal.findingId)?.ruleCode || '—') : '—';
      const sourceEntries=allEntries.filter(entry=>proposal.lines.includes(entry.id));
      const files=[...new Set(sourceEntries.map(entry=>entry.sourceFile))].join(' | ');
      const refs=sourceEntries.map(entry=>String(entry.sourceRow)).join(' | ');
      const status=proposal.status==='proposed'?'À examiner':proposal.status==='accepted'?'Retenue':'Refusée';
      lines.push([code,status,files,refs,proposal.description].map(escape).join(';'));
    }
    const blob=new Blob([`\uFEFF${lines.join('\r\n')}`],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`mizan-registre-corrections-${workspace.settings.fiscalYear}.csv`;link.click();URL.revokeObjectURL(url);
  };
  const exportAuditReport = async () => {
    const XLSX = await import('xlsx');
    const sourceName = activeDataset?.name || 'Périmètre actif';
    const sourceRowsFor = (item: AuditFinding) => entries.filter(entry=>item.sourceRowIds.includes(entry.id));
    const toStatus = (value: AuditFinding['status']) => value === 'reviewed' ? 'VÉRIFIÉ' : value === 'dismissed' ? 'ÉCARTÉ' : 'À EXAMINER';
    const semanticAdded = findings.filter(item=>item.origin==='semantic').length;
    const level1Enriched = findings.filter(item=>item.mergedSemantic?.length).length;
    const summary = [
      ['Rapport d’audit Mizan', sourceName], ['Cabinet', auth.activeWorkspace?.name || '—'],
      ['Client / dossier', auth.activeDossier?.clientName || '—'], ['Exercice fiscal', workspace.settings.fiscalYear],
      ['Type de document', activeDataset?.documentType || '—'], ['Lignes contrôlées', entries.length],
      ['Total débit (MAD)', totalDebit], ['Total crédit (MAD)', totalCredit],
      ['Écart débit - crédit (MAD)', totalDebit-totalCredit], ['Constats détectés', findings.length],
      ['dont Niveau 1 (déterministes)', deterministicFindings.length], ['dont Niveau 1 enrichis par une analyse IA fusionnée', level1Enriched], ['dont Niveau 2 (nouvelles anomalies IA acceptées par l’auditeur)', semanticAdded],
      ['Constats vérifiés', reviewed], ['Constats écartés', findings.filter(item=>item.status==='dismissed').length],
      ['Propositions confirmées', workspace.proposals.filter(item=>item.status==='accepted').length],
      ['Note', 'Rapport indicatif à valider par un professionnel ; les contrôles ne remplacent ni les pièces ni la réglementation applicable.'],
    ];
    const summarySheet = XLSX.utils.aoa_to_sheet(summary);
    summarySheet['!cols'] = [{ wch: 38 }, { wch: 86 }];
    const findingRows = findings.map(item=>{
      const source=sourceRowsFor(item);
      const proposal=workspace.proposals.find(value=>value.findingId===item.id);
      const mappedCols=activeDataset ? [activeDataset.mapping.debit,activeDataset.mapping.credit].filter(value=>value!=='').map(value=>activeDataset.headers[Number(value)]||`Colonne ${Number(value)+1}`).join(', ') : '';
      const entryLines=proposal?.journalEntry?.map(line=>`${line.accountCode} ${line.accountLabel} | Débit ${line.debit} | Crédit ${line.credit}`).join(' ; ') || '';
      return {
        'Code règle': [item.ruleCode, ...(item.mergedSemantic || []).map(value=>value.ruleCode)].join(' + '),
        'Origine': item.origin === 'semantic'
          ? `Niveau 2 IA · acceptée par l’auditeur (confiance ${item.confidence || 'faible'})`
          : item.mergedSemantic?.length ? `Niveau 1 · déterministe, enrichi par Niveau 2 IA (${item.mergedSemantic.map(value=>value.ruleCode).join(', ')})` : 'Niveau 1 · déterministe',
        'Sévérité': ({critical:'Critique',high:'Élevée',medium:'À vérifier',low:'Faible',info:'Information'} as Record<string,string>)[item.severity] || item.severity,
        'Constat': item.title,
        'Explication du problème': item.explanation,
        'Référence pièce / fichier / ligne source': [...new Set(source.map(row=>`${row.sourceFile} · ligne ${row.sourceRow}${row.reference?` · pièce ${row.reference}`:''}`))].join(' ; ') || 'Non renseignée',
        'Cellule(s) source(s)': `Ligne(s) ${source.map(row=>row.sourceRow).join(', ')} · Colonne(s) ${mappedCols || 'à vérifier'}`,
        'Montant MAD': item.amount,
        'État de validation': toStatus(item.status),
        'Proposition de correction': proposal?.description || item.suggestion,
        'État proposition': proposal?.status === 'accepted' ? 'CONFIRMÉE / APPLIQUÉE AU DOSSIER' : proposal?.status === 'rejected' ? 'REFUSÉE' : proposal ? 'PROPOSITION' : 'NON GÉNÉRÉE',
        'Écriture proposée': entryLines,
        'Confiance IA': proposal?.confidence || '',
      };
    });
    const findingsSheet = findingRows.length ? XLSX.utils.json_to_sheet(findingRows) : XLSX.utils.aoa_to_sheet([['Aucun constat détecté pour cette source.']]);
    findingsSheet['!cols'] = [{wch:14},{wch:34},{wch:14},{wch:36},{wch:72},{wch:60},{wch:40},{wch:18},{wch:20},{wch:76},{wch:28},{wch:70},{wch:16}];
    const workpaperRows: Record<string,string|number>[] = [];
    workpaperRows.push({'Section':'CONTRÔLES VALIDÉS','Contrôle / préconisation':'Les contrôles ci-dessous ont été marqués vérifiés par un utilisateur.','Statut':'À documenter','Référence':'—','Montant MAD':0});
    for(const item of findings.filter(value=>value.status==='reviewed')) {
      const source=sourceRowsFor(item);
      workpaperRows.push({'Section':'Contrôles validés','Contrôle / préconisation':`${item.ruleCode} · ${item.title}: ${item.explanation}`,'Statut':'VÉRIFIÉ','Référence':source.map(row=>`${row.sourceFile} · ligne ${row.sourceRow} · pièce ${row.reference||'—'}`).join(' ; '),'Montant MAD':item.amount});
    }
    workpaperRows.push({'Section':'PRÉCONISATIONS FISCALES · LIASSE / DGI','Contrôle / préconisation':'Préconisations de revue à rapprocher des pièces, comptes et règles officiellement applicables à l’exercice.','Statut':'À valider par un professionnel','Référence':'—','Montant MAD':0});
    for(const item of findings.filter(value=>value.ruleCode.startsWith('FISC') || value.ruleCode==='IA-DED-01' || value.ruleCode==='IA-TVA-01')) {
      const proposal=workspace.proposals.find(value=>value.findingId===item.id);
      const source=sourceRowsFor(item);
      workpaperRows.push({'Section':'Préconisations fiscales · Liasse / DGI', 'Contrôle / préconisation':`${item.ruleCode} · ${item.title}: ${proposal?.description || item.suggestion}${proposal?.journalEntry?.length ? ` Écriture : ${proposal.journalEntry.map(line=>`${line.accountCode} D ${line.debit} C ${line.credit}`).join(' ; ')}` : ''}`,'Statut':proposal?.status==='accepted'?'PROPOSITION CONFIRMÉE':toStatus(item.status),'Référence':source.map(row=>`${row.sourceFile} · ligne ${row.sourceRow} · pièce ${row.reference||'—'}`).join(' ; '),'Montant MAD':item.amount});
    }
    if(workpaperRows.length===2) workpaperRows.push({'Section':'Revue de dossier','Contrôle / préconisation':'Aucun constat vérifié ou préconisation fiscale générée pour la source sélectionnée.','Statut':'Sans élément','Référence':'—','Montant MAD':0});
    const workpaperSheet=XLSX.utils.json_to_sheet(workpaperRows);
    workpaperSheet['!cols']=[{wch:36},{wch:100},{wch:28},{wch:60},{wch:18}];
    const workbook=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook,summarySheet,'Résumé');
    XLSX.utils.book_append_sheet(workbook,findingsSheet,'Constats');
    XLSX.utils.book_append_sheet(workbook,workpaperSheet,'Dossier de travail');
    XLSX.writeFile(workbook,`mizan-rapport-audit-${workspace.settings.fiscalYear}.xlsx`);
  };
  return <Shell><PageHeading eyebrow="Contrôles locaux · piste de revue" title="Revue d’audit" description="Chaque signal explique son origine. Examinez les éléments avant de retenir une proposition." action={<div className="badge reviewed"><ShieldCheck size={12}/> {reviewed} vérifié(s)</div>}/>
    <div className="status-note"><strong>Rien n’est corrigé en silence.</strong> Une proposition doit être retenue explicitement par vous. Les constats sont des pistes indicatives, pas un avis certifié ni une conclusion fiscale.</div>
    <div className="findings-layout">
      <aside className="panel filters"><div className="section-head"><h3><Filter size={14} style={{verticalAlign:'middle',marginRight:6}}/>Affiner</h3><button className="button ghost small" onClick={()=>{setSeverity('Tous');setStatus('Tous');setSearch('');}} data-testid="button-reset-filters"><RotateCcw size={12}/> Réinitialiser</button></div>
        <label className="filter-label" htmlFor="find-search">Rechercher</label><div style={{position:'relative'}}><Search size={13} style={{position:'absolute',left:9,top:10,color:'hsl(var(--muted-foreground))'}}/><input id="find-search" className="search-input" style={{paddingLeft:28}} placeholder="Règle, constat…" value={search} onChange={event=>setSearch(event.target.value)} data-testid="input-search-findings"/></div>
        <div className="filter-label">Gravité</div>{['Tous','critical','high','medium','low','info'].map(item=><button key={item} className={`filter-button ${severity===item?'selected':''}`} onClick={()=>setSeverity(item)} data-testid={`filter-severity-${item}`}>{item==='Tous'?'Toutes':({critical:'Critique',high:'Élevée',medium:'À vérifier',low:'Faible',info:'Information'} as Record<string,string>)[item]}<span className="quiet">{item==='Tous'?listSource.length:listSource.filter(f=>f.severity===item).length}</span></button>)}
        <div className="filter-label">État de revue</div>{['Tous','À examiner','Vérifiés','Écartés'].map(item=><button key={item} className={`filter-button ${status===item?'selected':''}`} onClick={()=>setStatus(item)} data-testid={`filter-status-${item}`}>{item}<span className="quiet">{item==='Tous'?listSource.length:listSource.filter(f=>item==='À examiner'?f.status==='open':item==='Vérifiés'?f.status==='reviewed':f.status==='dismissed').length}</span></button>)}
      </aside>
      <div>
        <section className="panel">
          <div className="level-tabs" role="tablist" aria-label="Niveau d’audit">
            <button role="tab" aria-selected={level==='level1'} className={`level-tab ${level==='level1'?'active':''}`} onClick={()=>{setLevel('level1');setSelectedFindingId(null);}} data-testid="tab-level1"><ShieldCheck size={15}/><span><strong>Niveau 1 · Constats déterministes</strong><small>Certitude de calcul 100 % · {deterministicFindings.length} constat(s)</small></span></button>
            <button role="tab" aria-selected={level==='level2'} className={`level-tab ${level==='level2'?'active':''}`} onClick={()=>{setLevel('level2');setSelectedFindingId(null);}} data-testid="tab-level2"><Cpu size={15}/><span><strong>Niveau 2 · Constats sémantiques IA</strong><small>Prédictions à vérifier · {semanticItems.filter(item=>item.decision==='pending').length} en attente · {semanticItems.filter(item=>item.decision==='merged'&&item.level1).length} fusionnée(s) au Niveau 1 · {semanticItems.filter(item=>item.decision==='merged'&&!item.level1).length} ajoutée(s)</small></span></button>
          </div>
          <div className="panel-pad" style={{paddingBottom:12}}><div className="section-head" style={{marginBottom:0}}><div><h2>{level==='level1'?'Tableau des constats déterministes (Niveau 1)':'Tableau des constats sémantiques IA (Niveau 2)'}</h2><small>{filtered.length} sur {listSource.length} · {level==='level1'?'règles exactes exécutées localement, sans IA ni coût API':'analyse autonome à comparer au Niveau 1 ; une prédiction acceptée sur une pièce déjà relevée enrichit le constat Niveau 1, sinon elle s’ajoute au dossier de travail'}</small></div><div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}><button className="button small" onClick={()=>void exportAuditReport()} disabled={!entries.length} data-testid="button-export-audit-report"><ArrowDownToLine size={12}/> Exporter le rapport (Excel)</button><span className="badge">{entries.length} lignes analysées</span></div></div></div>
          {level==='level2' && <SemanticRunPanel/>}
          {filtered.length ? <div className={`review-split ${selectedFindingId && filtered.some(item=>item.id===selectedFindingId) ? 'with-detail' : ''}`}>
            <div className="review-table-pane">{level==='level2' ? semanticTable : <div className="table-wrap findings-table-wrap"><table className="findings-table"><thead><tr><th>Règle & sévérité</th><th>Référence pièce / ligne source</th><th>Montant MAD</th><th>Explication du problème</th><th>Proposition de correction</th><th>Statut & actions</th></tr></thead><tbody>{filtered.map(finding=>{
              const source=entries.filter(entry=>finding.sourceRowIds.includes(entry.id));
              const proposal=workspace.proposals.find(item=>item.findingId===finding.id);
              const sourceLabel=source.slice(0,3).map(entry=>`${entry.reference || 'Pièce —'} · ligne ${entry.sourceRow}`).join(' ; ')+(source.length>3?` · +${source.length-3}`:'');
              const inWorkingFile=findingsById.get(finding.id) || finding;
              return <tr key={finding.id} className={selectedFindingId===finding.id?'selected-finding-row':''} onClick={()=>setSelectedFindingId(finding.id)} tabIndex={0} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setSelectedFindingId(finding.id);}}}>
                <td><strong className="mono">{finding.ruleCode}</strong><div style={{marginTop:5}}><Severity value={finding.severity}/></div>{inWorkingFile.mergedSemantic?.length ? <div style={{marginTop:5}}><OriginBadge finding={inWorkingFile}/></div> : null}</td>
                <td style={{whiteSpace:'normal',minWidth:150}}><span>{sourceLabel || 'Référence non renseignée'}</span><div className="quiet">{source[0]?.sourceFile || activeDataset?.name || '—'}</div></td>
                <td className="mono">{formatMad(finding.amount)}</td>
                <td className="finding-cell-copy">{finding.title}<small>{finding.explanation}</small></td>
                <td className="finding-cell-copy">{proposal?.description || finding.suggestion}<small>{proposal?.status==='accepted'?'Correction confirmée':proposal?.status==='rejected'?'Proposition refusée':proposal?'Proposition en attente':'À proposer'}</small></td>
                <td><span className={`badge ${finding.status==='reviewed'?'reviewed':''}`}>{finding.status==='open'?'À examiner':finding.status==='reviewed'?'Vérifié':'Écarté'}</span><button className="button small" style={{marginTop:7}} onClick={event=>{event.stopPropagation();setSelectedFindingId(finding.id);}}><Eye size={12}/> Détail & source</button></td>
              </tr>;
            })}</tbody></table></div>}</div>
            {selectedFindingId && filtered.some(item=>item.id===selectedFindingId) && <aside className="review-detail-pane" ref={detailPaneRef}><FindingCard key={selectedFindingId} finding={filtered.find(item=>item.id===selectedFindingId)!} pendingItem={semanticById.get(selectedFindingId)?.decision === 'merged' ? undefined : semanticById.get(selectedFindingId)} onClose={()=>setSelectedFindingId(null)}/></aside>}
          </div> : level==='level2'
            ? <EmptyState title={semanticItems.length?'Aucune prédiction pour ces filtres':'Aucune prédiction IA pour cette source'} description={semanticItems.length?'Réinitialisez les filtres pour revoir toutes les prédictions.':'Lancez le Niveau 2 ci-dessus. Les prédictions apparaîtront ici, en attente de votre décision ; rien n’entre dans le dossier sans acceptation.'} icon={<Cpu size={17}/>}/>
            : <EmptyState title={entries.length?'Aucun constat pour ces filtres':'Aucune donnée à contrôler'} description={entries.length?'Aucun élément ne correspond aux filtres. Vous pouvez réinitialiser la recherche.':'Importez un fichier pour lancer les règles de contrôle locales. Les résultats ne sont pas préremplis.'} icon={<ClipboardCheck size={17}/>}/>}
        </section>
    <section className="panel panel-pad" style={{marginTop:14}}>
          <div className="section-head"><div><div className="eyebrow">Facultatif · données agrégées</div><h2>Demander une explication priorisée</h2><small>La revue IA reçoit uniquement exercice, totaux, codes et intitulés de règles agrégés.</small></div><Sparkles size={17} color="hsl(var(--primary))"/></div>
          <label className="consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} data-testid="checkbox-ai-consent"/><span>Je consens explicitement à transmettre à l’API Groq, pour obtenir une explication, l’exercice, les totaux débit/crédit et, pour chaque code de règle, son intitulé et le nombre de constats. Ces intitulés sont des textes fixes de Mizan (par exemple « Solde inversé sur compte de tiers ») et ne contiennent aucune donnée de votre dossier. Aucun fichier, numéro ou libellé de compte ni écriture détaillée n’est inclus ; l’usage est décompté sur le compte Groq associé à la clé configurée (offre gratuite limitée ou facturation).</span></label>
          <button className="button primary" disabled={!consent||!entries.length||ai.isPending} onClick={requestReview} data-testid="button-ai-review">{ai.isPending?'Préparation de la revue…':<><Sparkles size={14}/> Demander la revue agrégée</>}</button>
          {!entries.length&&<span className="quiet" style={{marginLeft:10}}>Importez des données avant d’activer la demande.</span>}
          {aiError&&<div className="status-note" style={{marginTop:13}}>{aiError}</div>}
          {ai.isError&&<button className="button small" style={{marginLeft:8}} onClick={requestReview} disabled={!consent||!entries.length} data-testid="button-ai-retry"><RotateCcw size={12}/> Réessayer</button>}
          {ai.data&&<div style={{marginTop:17}}><div className="eyebrow">Synthèse fournie par l’IA</div><div className="review-summary" data-testid="text-ai-summary">{ai.data.executiveSummary}</div>{ai.data.priorities.map((priority,index)=><div key={`${priority.title}-${index}`} className="priority-item"><div style={{display:'flex',gap:8,alignItems:'center',marginBottom:6}}><Severity value={priority.severity}/><strong style={{fontSize:12}}>{priority.title}</strong></div><p className="finding-desc">{priority.explanation}</p><div className="quiet" style={{marginTop:6}}>Action suggérée : {priority.suggestedAction}</div></div>)}<Notice>{ai.data.limitations} Cette explication est indicative et ne remplace pas le jugement professionnel.</Notice></div>}
        </section>
      </div>
    </div>
    <section className="panel" style={{marginTop:15}}><div className="panel-pad"><div className="section-head"><div><h2>Journal de revue</h2><small>Historique de revue associé au dossier actif</small></div><div style={{display:'flex',gap:8,alignItems:'center'}}><button className="button small" onClick={exportRegister} disabled={!workspace.proposals.length} data-testid="button-export-corrections"><ArrowDownToLine size={12}/> Exporter les propositions</button><span className="badge">{workspace.trail.length} événement(s)</span></div></div>
      {workspace.trail.length ? <div className="table-wrap"><table><thead><tr><th>Date</th><th>Action</th><th>Détail</th></tr></thead><tbody>{workspace.trail.map(item=><tr key={item.id}><td>{shortDate(item.at)}</td><td>{item.action}</td><td>{item.detail}</td></tr>)}</tbody></table></div> : <EmptyState title="Aucune action enregistrée" description="Les décisions de revue apparaîtront ici, avec leur horodatage."/ >}
    </div></section>
  </Shell>;
}

const crcTable = (() => { const table = new Uint32Array(256); for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;} return table; })();
function crc32(bytes: Uint8Array) { let crc=0xffffffff; for(const byte of bytes) crc=crcTable[(crc^byte)&0xff]^(crc>>>8); return (crc^0xffffffff)>>>0; }
function createZip(filename: string, content: string) {
  const encoder = new TextEncoder(), name = encoder.encode(filename), data = encoder.encode(content), crc = crc32(data);
  const local = new Uint8Array(30+name.length+data.length); const lv=new DataView(local.buffer);
  lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x0800,true);lv.setUint16(8,0,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,name.length,true);local.set(name,30);local.set(data,30+name.length);
  const central=new Uint8Array(46+name.length);const cv=new DataView(central.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x0800,true);cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,name.length,true);cv.setUint32(42,0,true);central.set(name,46);
  const end=new Uint8Array(22);const ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,1,true);ev.setUint16(10,1,true);ev.setUint32(12,central.length,true);ev.setUint32(16,local.length,true);
  return new Blob([local,central,end],{type:'application/zip'});
}
function SettingsPage() {
  const { workspace, updateSettings, clearLocalData, entries, findings } = useWorkspace();
  const auth = useAuth();
  const canEdit = auth.activeWorkspace?.role !== 'client';
  const [year,setYear]=useState(String(workspace.settings.fiscalYear));
  const [rates,setRates]=useState(workspace.settings.vatRates.join(', '));
  const [collectedPrefixes,setCollectedPrefixes]=useState((workspace.settings.vatCollectedPrefixes || []).join(', '));
  const [recoverablePrefixes,setRecoverablePrefixes]=useState((workspace.settings.vatRecoverablePrefixes || []).join(', '));
  const [saved,setSaved]=useState(false);
  useEffect(()=>{setYear(String(workspace.settings.fiscalYear));setRates(workspace.settings.vatRates.join(', '));setCollectedPrefixes((workspace.settings.vatCollectedPrefixes || []).join(', '));setRecoverablePrefixes((workspace.settings.vatRecoverablePrefixes || []).join(', '));setSaved(false);},[auth.activeDossierId, workspace.settings.fiscalYear, JSON.stringify(workspace.settings.vatRates), JSON.stringify(workspace.settings.vatCollectedPrefixes), JSON.stringify(workspace.settings.vatRecoverablePrefixes)]);
  const save=async()=>{const parsedRates=rates.split(/[;, ]+/).map(Number).filter(value=>Number.isFinite(value)&&value>0&&value<100);const parsePrefixes=(value:string)=>[...new Set(value.split(/[;, ]+/).map(item=>item.replace(/\D/g,'')).filter(Boolean))];const parsedYear=Number(year);if(!Number.isInteger(parsedYear)||parsedYear<1990||parsedYear>2100){setSaved(false);return;}const success=await updateSettings({...workspace.settings,fiscalYear:parsedYear,vatRates:[...new Set(parsedRates)],vatCollectedPrefixes:parsePrefixes(collectedPrefixes),vatRecoverablePrefixes:parsePrefixes(recoverablePrefixes)});setSaved(success);};
  const download=()=>{const archive=createZip('mizan-source.json',JSON.stringify({exportedAt:new Date().toISOString(),settings:workspace.settings,datasets:workspace.datasets,findings,reviewTrail:workspace.trail,proposals:workspace.proposals},null,2));const url=URL.createObjectURL(archive);const link=document.createElement('a');link.href=url;link.download=`mizan-donnees-locales-${workspace.settings.fiscalYear}.zip`;link.click();URL.revokeObjectURL(url);};
  const clear=()=>{if(window.confirm('Supprimer tous les imports et constats associés au dossier actif dans PostgreSQL ? Cette action est définitive.')) clearLocalData();};
  return <Shell><PageHeading eyebrow="Configuration du dossier" title="Paramètres" description="Période, taux indicatifs et paramètres persistés pour le dossier actif."/>
    <div className="page-grid">
      <div>
        <section className="panel panel-pad"><div className="section-head"><div><h2>Période fiscale</h2><small>Utilisée pour contextualiser le dossier et la revue agrégée IA.</small></div><ChevronDown size={15}/></div>
          <div className="form-row"><div className="field"><label htmlFor="fiscal-year">Exercice fiscal</label><input id="fiscal-year" type="number" min="1990" max="2100" value={year} onChange={event=>{setYear(event.target.value);setSaved(false);}} data-testid="input-fiscal-year"/></div><div className="field"><label htmlFor="vat-rates">Taux de TVA de référence (%)</label><input id="vat-rates" value={rates} onChange={event=>{setRates(event.target.value);setSaved(false);}} placeholder="Vide = 20, 14, 10, 7" data-testid="input-vat-rates"/></div></div>
          <div className="form-row" style={{marginTop:12}}><div className="field"><label htmlFor="vat-collected">Préfixes comptes TVA collectée</label><input id="vat-collected" value={collectedPrefixes} onChange={event=>{setCollectedPrefixes(event.target.value);setSaved(false);}} placeholder="Ex. 4455" data-testid="input-vat-collected-prefixes"/></div><div className="field"><label htmlFor="vat-recoverable">Préfixes comptes TVA récupérable</label><input id="vat-recoverable" value={recoverablePrefixes} onChange={event=>{setRecoverablePrefixes(event.target.value);setSaved(false);}} placeholder="Ex. 3455" data-testid="input-vat-recoverable-prefixes"/></div></div>
          <div className="quiet" style={{marginBottom:14}}>FISC-03 compare le compte 3455 aux charges de classe 6 par pièce. Si ce champ reste vide, les taux de référence fournis sont 20, 14, 10 et 7 % ; vous pouvez les adapter à l’exercice. Les rapprochements sont indicatifs : vérifiez les taux officiels et les pièces, surtout en cas de taux multiples.</div>
          <button className="button primary" onClick={()=>void save()} disabled={!canEdit} data-testid="button-save-settings"><Check size={14}/> Enregistrer les paramètres</button>{saved&&<span className="quiet" style={{marginLeft:10}}>Paramètres enregistrés dans PostgreSQL.</span>}
        </section>
        <section className="panel panel-pad" style={{marginTop:14}}><div className="section-head"><div><h2>Confidentialité & stockage</h2><small>Vos données comptables restent sous votre contrôle.</small></div><LockKeyhole size={16}/></div>
          <div className="status-note"><strong>Stockage PostgreSQL actif.</strong> Les imports, constats et propositions sont enregistrés côté serveur et rattachés au dossier client et à son cabinet. L’accès est contrôlé par une session sécurisée et les appartenances de cabinet.</div>
          <div className="data-note">Les fichiers source structurés sont conservés en base de données. Les données détaillées ne sont envoyées à Groq que lorsque vous déclenchez explicitement une correction IA ou une analyse de Niveau 2 (lignes du périmètre choisi, sans nom de fichier ni de client) ; la revue agrégée séparée ne transmet que des totaux, des codes de règles et leurs intitulés fixes.</div>
          <div className="section-head" style={{marginTop:16}}><div><strong style={{fontSize:12}}>Données du dossier actif</strong><div className="quiet">{formatNumber(entries.length)} lignes dans la source active · {workspace.datasets.length} fichier(s) source · {findings.length} constats calculés</div></div><button className="button small" onClick={download} disabled={!entries.length} data-testid="button-download-zip"><ArrowDownToLine size={13}/> Exporter le dossier (ZIP)</button></div>
          <div style={{marginTop:9}}><a className="button small" href={`${import.meta.env.BASE_URL}mizan-code-source.zip`} download="mizan-code-source.zip" data-testid="link-download-source-code"><ArrowDownToLine size={13}/> Télécharger le code complet (ZIP)</a></div>
          <button className="button small" style={{marginTop:7,color:'hsl(var(--destructive))'}} onClick={clear} disabled={!canEdit || !workspace.datasets.length} data-testid="button-clear-local"><Trash2 size={13}/> Supprimer les imports du dossier</button>
        </section>
      </div>
      <aside>
        <section className="panel panel-pad"><div className="section-head"><h3><CircleHelp size={15} style={{verticalAlign:'middle',marginRight:6}}/>Limites d’utilisation</h3></div><div style={{fontSize:11,lineHeight:1.65,color:'hsl(var(--muted-foreground))'}}><p>Mizan relève des signaux selon des règles explicites. Une anomalie peut être justifiée par le contexte, et l’absence de signal ne garantit pas l’exhaustivité.</p><p>Les corrections restent des propositions soumises à votre validation. Aucune écriture n’est modifiée sans action de votre part.</p><p>Les sorties sont indicatives, doivent être revues par un professionnel et ne sont ni un conseil fiscal certifié ni une attestation de conformité.</p></div></section>
        <section className="panel panel-pad" style={{marginTop:12}}><div className="eyebrow">Piste de revue</div><h3>Historique du dossier</h3><p className="quiet" style={{lineHeight:1.6,marginTop:9}}>Les statuts de constats, propositions et paramètres sont persistés dans PostgreSQL. Le journal d’événements affiché ici concerne la session courante ; exportez le dossier pour conserver une copie de travail.</p><Link href="/audit" className="button small">Consulter le journal <ArrowRight size={12}/></Link></section>
      </aside>
    </div>
  </Shell>;
}

type AiUsage = {
  configured: boolean; model: string; plan: 'free' | 'paid'; day: string;
  requests: number; failedRequests: number; promptTokens: number; completionTokens: number; totalTokens: number;
  dailyTokenLimit: number; dailyRequestLimit: number; requestsToday: number;
  tokenPercent: number; requestPercent: number; usagePercent: number;
  keyStatus: 'not_configured' | 'active' | 'limit_reached' | 'invalid';
  lastCallAt: string | null; lastError: string | null; retryAfterSeconds: number | null;
  rateLimit: { limitRequests: number | null; remainingRequests: number | null; resetRequests: string | null; limitTokens: number | null; remainingTokens: number | null; resetTokens: string | null; observedAt: string } | null;
};
const FREE_PLAN_REQUESTS_PER_DAY = 1000;
const KEY_STATUS: Record<AiUsage['keyStatus'], { label: string; tone: string; help: string }> = {
  active: { label: 'Active', tone: 'reviewed', help: 'La clé est acceptée par Groq et le quota n’est pas épuisé.' },
  limit_reached: { label: 'Limite atteinte', tone: 'high', help: 'Groq refuse temporairement les appels ou le quota journalier est consommé. Le Niveau 1 reste disponible.' },
  invalid: { label: 'Clé refusée', tone: 'high', help: 'Groq a refusé la clé (401/403). Vérifiez GROQ_API_KEY.' },
  not_configured: { label: 'Non configurée', tone: '', help: 'Aucune GROQ_API_KEY sur le serveur : seules les règles déterministes fonctionnent.' },
};
function UsageMeter({ label, used, limit, percent, unit }: { label: string; used: number; limit: number; percent: number; unit: string }) {
  const tone = percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : '';
  return <div className="usage-meter">
    <div className="section-head" style={{marginBottom:0}}><strong style={{fontSize:12}}>{label}</strong><span className="mono">{formatNumber(percent)} %</span></div>
    <div className="progress-track usage-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className={`progress-fill ${tone}`} style={{width:`${Math.max(percent>0?1:0, Math.min(100, percent))}%`}}/></div>
    <small className="quiet">{formatNumber(used)} / {formatNumber(limit)} {unit}</small>
  </div>;
}
function UsagePage() {
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const usage = useQuery({ queryKey: AI_USAGE_KEY, queryFn: () => apiJson<AiUsage>('/api/ai/usage'), refetchInterval: 30_000 });
  const checkKey = async () => {
    setChecking(true); setCheckError('');
    try { queryClient.setQueryData(AI_USAGE_KEY, await apiJson<AiUsage>('/api/ai/usage/check', { method: 'POST' })); }
    catch (error) { setCheckError(errorMessage(error, 'Vérification impossible.')); }
    finally { setChecking(false); }
  };
  const data = usage.data;
  const status = data ? KEY_STATUS[data.keyStatus] : null;
  const observedLimit = data?.rateLimit?.limitRequests ?? null;
  const planObservation = observedLimit === null
    ? 'Limites Groq pas encore observées aujourd’hui : elles s’affichent après le premier appel IA.'
    : observedLimit > FREE_PLAN_REQUESTS_PER_DAY
      ? `Limites observées chez Groq (${formatNumber(observedLimit)} requêtes/jour) supérieures au plan gratuit : compte probablement en offre payante (Developer).`
      : `Limites observées chez Groq (${formatNumber(observedLimit)} requêtes/jour, ${formatNumber(data?.rateLimit?.limitTokens ?? 0)} tokens/minute) : celles du plan gratuit.`;
  return <Shell><PageHeading eyebrow="Fournisseur IA · Groq" title="Consommation IA" description="Suivi des appels, des tokens et du quota de la clé Groq utilisée par le Niveau 2, les corrections IA et la revue agrégée." action={<div style={{display:'flex',gap:8}}><button className="button small" onClick={()=>void usage.refetch()} disabled={usage.isFetching} data-testid="button-usage-refresh"><RotateCcw size={12} className={usage.isFetching?'spin':''}/> Actualiser</button><button className="button small primary" onClick={()=>void checkKey()} disabled={checking} data-testid="button-usage-check"><KeyRound size={12}/> {checking?'Vérification…':'Vérifier la clé'}</button></div>}/>
    {usage.isError && <div className="status-note" role="alert">{errorMessage(usage.error, 'Impossible de lire la consommation IA.')}</div>}
    {checkError && <div className="status-note" role="alert">{checkError}</div>}
    {!data ? (usage.isLoading ? <div className="panel panel-pad"><small className="quiet">Lecture du compteur…</small></div> : null) : <>
      <section className="panel panel-pad usage-hero">
        <div className="section-head"><div><div className="eyebrow">Consommation du jour · {data.day} (UTC)</div><h2>Jauge d’utilisation du quota</h2><small>La valeur retenue est la plus élevée des deux jauges : tokens du jour et requêtes du jour.</small></div><span className={`badge ${data.usagePercent>=90?'high':data.usagePercent>=70?'medium':'reviewed'}`} data-testid="badge-usage-percent">{formatNumber(data.usagePercent)} % utilisé</span></div>
        <div className="usage-gauge"><div className="usage-gauge-value mono">{formatNumber(data.usagePercent)}<span>%</span></div><div className="usage-gauge-bars">
          <UsageMeter label="Tokens consommés aujourd’hui" used={data.totalTokens} limit={data.dailyTokenLimit} percent={data.tokenPercent} unit="tokens (limite journalière configurée)"/>
          <UsageMeter label="Requêtes aujourd’hui" used={data.requestsToday} limit={data.dailyRequestLimit} percent={data.requestPercent} unit={data.rateLimit?.limitRequests ? 'requêtes (compteur Groq de l’organisation)' : 'requêtes (compteur de ce serveur)'}/>
        </div></div>
        {data.rateLimit?.limitTokens != null && <div className="data-note">Débit par minute : {formatNumber(data.rateLimit.remainingTokens ?? 0)} tokens disponibles sur {formatNumber(data.rateLimit.limitTokens)} au dernier appel{data.rateLimit.resetTokens?`, plein rétabli en ${data.rateLimit.resetTokens}`:''}. Le Niveau 2 attend automatiquement lorsque cette limite est atteinte.</div>}
      </section>
      <div className="stat-grid" style={{marginTop:14}}>
        <Stat label="Requêtes exécutées" value={formatNumber(data.requests)} foot={`${data.failedRequests} en échec · par ce serveur aujourd’hui`} icon={<Activity size={15}/>}/>
        <Stat label="Tokens consommés" value={formatNumber(data.totalTokens)} foot={`${formatNumber(data.promptTokens)} en entrée · ${formatNumber(data.completionTokens)} en sortie`} icon={<Layers size={15}/>}/>
        <section className="panel stat-card" data-testid="stat-statut-cle"><div className="stat-label"><span>Statut de la clé API</span><KeyRound size={15}/></div><div className="stat-value" style={{fontSize:18}}><span className={`badge ${status!.tone}`} style={{fontSize:11}}>{status!.label}</span></div><div className="stat-foot">{data.retryAfterSeconds ? `Reprise possible dans ${data.retryAfterSeconds} s.` : status!.help}</div></section>
        <section className="panel stat-card" data-testid="stat-plan"><div className="stat-label"><span>Plan Groq</span><Gauge size={15}/></div><div className="stat-value" style={{fontSize:18}}><span className={`badge ${data.plan==='free'?'reviewed':'medium'}`} style={{fontSize:11}}>{data.plan==='free'?'Gratuit (sans facturation)':'Payant (facturé à l’usage)'}</span></div><div className="stat-foot">Plan déclaré par GROQ_PLAN · modèle {data.model}</div></section>
      </div>
      <section className="panel panel-pad" style={{marginTop:14}}>
        <div className="section-head"><div><h2>Détail et limites</h2><small>Lecture honnête des chiffres affichés</small></div><CircleHelp size={16}/></div>
        <div className="data-note">{planObservation}</div>
        {data.lastError && <div className="status-note" role="status" style={{marginTop:10}}>Dernier incident : {data.lastError}{data.lastCallAt?` (${shortDate(data.lastCallAt)})`:''}.</div>}
        <ul className="proposal-list" style={{marginTop:10}}>
          <li>Les tokens sont comptés par ce serveur Mizan depuis minuit UTC ou depuis son dernier redémarrage. D’autres applications utilisant la même clé ne sont pas incluses.</li>
          <li>Le compteur de requêtes provient des en-têtes Groq (<span className="mono">x-ratelimit-*</span>) dès le premier appel : il couvre toute l’organisation Groq.</li>
          <li>Limite journalière de tokens : {formatNumber(data.dailyTokenLimit)} (variable GROQ_DAILY_TOKEN_LIMIT ; 200 000 par défaut, valeur publiée par Groq pour ce modèle en plan gratuit).</li>
          <li>Groq ne fournit pas d’API de facturation : le plan affiché est celui déclaré dans GROQ_PLAN. La consommation officielle se consulte sur console.groq.com.</li>
          <li>Vérifier la clé interroge la liste des modèles Groq, sans consommer de tokens.</li>
        </ul>
        {data.lastCallAt && <div className="quiet" style={{marginTop:8}}>Dernier appel : {shortDate(data.lastCallAt)}</div>}
      </section>
    </>}
  </Shell>;
}

function Router() {
  const auth = useAuth();
  const audit = useAudit(auth.activeDossierId, auth.activeDossier?.exerciceAnnee, auth.activeDossier?.settingsJson);
  return <AuditContext.Provider value={audit}><Switch>
    <Route path="/" component={OverviewPage}/>
    <Route path="/import" component={ImportPage}/>
    <Route path="/audit" component={ReviewPage}/>
    <Route path="/settings" component={SettingsPage}/>
    <Route path="/usage" component={UsagePage}/>
    <Route component={NotFound}/>
  </Switch></AuditContext.Provider>;
}
function App() {
  return <QueryClientProvider client={queryClient}><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><AuthGate><Router/></AuthGate></WouterRouter></QueryClientProvider>;
}
export default App;
