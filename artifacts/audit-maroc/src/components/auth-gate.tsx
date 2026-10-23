import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, KeyRound, ShieldCheck, UserPlus } from 'lucide-react';
import { ApiError, apiFetch, apiJson, errorMessage, jsonBody, WRITE_TIMEOUT_MS } from '@/lib/api';

type UserProfile = { id: string; email: string; name: string; role: 'admin' | 'auditeur' | 'client' };
type WorkspaceRecord = { id: string; name: string; role: 'admin' | 'auditeur' | 'client'; createdAt?: string };
type DossierRecord = { id: string; workspaceId: string; clientName: string; exerciceAnnee: number; status: string; createdAt?: string; settingsJson?: { fiscalYear?: number; vatRates?: number[]; vatCollectedPrefixes?: string[]; vatRecoverablePrefixes?: string[] } | null };
type AuthContextValue = {
  user: UserProfile;
  workspaces: WorkspaceRecord[];
  dossiers: DossierRecord[];
  activeWorkspaceId: string | null;
  activeDossierId: string | null;
  activeWorkspace?: WorkspaceRecord;
  activeDossier?: DossierRecord;
  selectWorkspace: (id: string) => void;
  selectDossier: (id: string) => void;
  createDossier: (clientName: string, exerciceAnnee: number) => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  addWorkspaceMember: (email: string, role: 'auditeur' | 'client') => Promise<void>;
  refreshDossiers: () => Promise<void>;
  logout: () => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Session utilisateur manquante');
  return value;
}

function AuthPage({ onAuthenticated, initialError }: { onAuthenticated: () => Promise<void>; initialError?: string }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [clientName, setClientName] = useState('');
  const [exerciceAnnee, setExerciceAnnee] = useState(String(new Date().getFullYear()));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      await apiFetch(`/api/auth/${mode}`, {
        method: 'POST',
        ...jsonBody({ email, password, name, workspaceName, clientName, exerciceAnnee: Number(exerciceAnnee) }),
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      await onAuthenticated();
    } catch (cause) {
      setError(errorMessage(cause, 'Erreur de connexion au serveur.'));
    } finally {
      // Always clears, so the submit button cannot stay stuck on "Connexion…".
      setBusy(false);
    }
  };
  return <div className="auth-shell">
    <div className="auth-brand"><span className="brand-mark">م</span><div><div className="brand-name">Mizan</div><div className="brand-caption">Audit workspace · Maroc</div></div></div>
    <section className="panel auth-panel">
      <div className="eyebrow">Espace de travail sécurisé</div>
      <h1>{mode === 'login' ? 'Connexion à Mizan' : 'Créer votre espace Mizan'}</h1>
      <p className="subhead">Dossiers, imports et décisions de revue conservés dans PostgreSQL avec accès par session.</p>
      <div className="auth-tabs"><button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => {setMode('login');setError('');}}><KeyRound size={14}/> Connexion</button><button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => {setMode('register');setError('');}}><UserPlus size={14}/> Inscription</button></div>
      <form onSubmit={submit} className="auth-form">
        {mode === 'register' && <>
          <div className="field"><label htmlFor="auth-name">Nom complet</label><input id="auth-name" required minLength={2} maxLength={120} autoComplete="name" value={name} onChange={event=>setName(event.target.value)} placeholder="Nom et prénom"/></div>
          <div className="field"><label htmlFor="auth-workspace">Cabinet / espace de travail</label><input id="auth-workspace" maxLength={160} value={workspaceName} onChange={event=>setWorkspaceName(event.target.value)} placeholder="Cabinet Mizan"/></div>
          <div className="form-row"><div className="field"><label htmlFor="auth-client">Premier dossier client</label><input id="auth-client" maxLength={200} value={clientName} onChange={event=>setClientName(event.target.value)} placeholder="Client à définir"/></div><div className="field"><label htmlFor="auth-year">Exercice</label><input id="auth-year" type="number" min={1990} max={2100} required value={exerciceAnnee} onChange={event=>setExerciceAnnee(event.target.value)}/></div></div>
        </>}
        <div className="field"><label htmlFor="auth-email">Adresse e-mail</label><input id="auth-email" type="email" required maxLength={254} autoComplete="email" value={email} onChange={event=>setEmail(event.target.value)} placeholder="vous@cabinet.ma"/></div>
        <div className="field"><label htmlFor="auth-password">Mot de passe</label><input id="auth-password" type="password" required minLength={mode === 'register' ? 10 : 1} maxLength={200} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={event=>setPassword(event.target.value)} placeholder={mode === 'register' ? '10 caractères minimum' : 'Votre mot de passe'}/>{mode === 'register' && <small className="quiet">10 caractères minimum. Le mot de passe est haché côté serveur.</small>}</div>
        {(error || initialError) && <div className="status-note" role="alert">{error || initialError}</div>}
        <button className="button primary auth-submit" type="submit" disabled={busy}>{busy ? 'Connexion…' : mode === 'login' ? 'Se connecter' : 'Créer le compte'}</button>
      </form>
      <div className="auth-security"><ShieldCheck size={15}/><span>Session HTTP-only · mot de passe haché · accès aux données limité aux cabinets autorisés</span></div>
    </section>
    <div className="auth-foot"><Activity size={13}/> Audit indicatif · validation humaine obligatoire</div>
  </div>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [dossiers, setDossiers] = useState<DossierRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [activeDossierId, setActiveDossierId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDossiers, setLoadingDossiers] = useState(false);
  const [authError, setAuthError] = useState('');

  const refreshSession = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiJson<{ user: UserProfile; workspaces: WorkspaceRecord[] }>('/api/auth/me');
      setUser(result.user); setWorkspaces(result.workspaces || []);
      setActiveWorkspaceId(current => current && (result.workspaces || []).some(item=>item.id===current) ? current : result.workspaces?.[0]?.id || null);
      setAuthError('');
    } catch (cause) {
      // 401 is the normal "not signed in" case, not an error to display.
      if (cause instanceof ApiError && cause.status === 401) {
        setUser(null); setWorkspaces([]); setDossiers([]); setActiveWorkspaceId(null); setActiveDossierId(null); setAuthError('');
        return;
      }
      setAuthError(errorMessage(cause, 'Le serveur Mizan est inaccessible. Vérifiez que l’API et DATABASE_URL sont configurés.'));
    } finally {
      // Bounded by apiJson's deadline, so the "Vérification de la session…"
      // screen can never become permanent.
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshSession(); }, [refreshSession]);

  const refreshDossiers = useCallback(async () => {
    if (!user || !activeWorkspaceId) { setDossiers([]); setActiveDossierId(null); return; }
    setLoadingDossiers(true);
    try {
      const result = await apiJson<{ dossiers?: DossierRecord[] }>(
        `/api/dossiers?workspaceId=${encodeURIComponent(activeWorkspaceId)}`,
      );
      const list = result.dossiers || [];
      setDossiers(list);
      setActiveDossierId(current => current && list.some(item=>item.id===current) ? current : list[0]?.id || null);
      setAuthError('');
    } catch (cause) {
      setAuthError(errorMessage(cause, 'Erreur de chargement des dossiers.'));
    } finally { setLoadingDossiers(false); }
  }, [user, activeWorkspaceId]);
  useEffect(() => { void refreshDossiers(); }, [refreshDossiers]);

  const selectWorkspace = (id: string) => { setActiveWorkspaceId(id); setDossiers([]); setActiveDossierId(null); };
  const createDossier = async (clientName: string, exerciceAnnee: number) => {
    if (!activeWorkspaceId) throw new Error('Choisissez un cabinet avant de créer un dossier.');
    const result = await apiJson<{ dossier?: DossierRecord }>('/api/dossiers', {
      method: 'POST',
      ...jsonBody({ workspaceId: activeWorkspaceId, clientName, exerciceAnnee }),
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    if (!result.dossier) throw new Error('Impossible de créer le dossier : le serveur n’a pas renvoyé de dossier.');
    setDossiers(current => [...current, result.dossier!]); setActiveDossierId(result.dossier.id);
  };
  const createWorkspace = async (name: string) => {
    const result = await apiJson<{ workspace?: { id: string; name: string; createdAt?: string } }>('/api/workspaces', {
      method: 'POST',
      ...jsonBody({ name }),
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    if (!result.workspace) throw new Error('Impossible de créer le cabinet : le serveur n’a pas renvoyé de cabinet.');
    setWorkspaces(current => [...current, { ...result.workspace!, role: 'admin' }]);
    setActiveWorkspaceId(result.workspace.id);
    setDossiers([]);
    setActiveDossierId(null);
  };
  const addWorkspaceMember = async (email: string, role: 'auditeur' | 'client') => {
    if (!activeWorkspaceId) throw new Error('Aucun cabinet actif.');
    await apiFetch(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/members`, {
      method: 'POST',
      ...jsonBody({ email, role }),
      timeoutMs: WRITE_TIMEOUT_MS,
    });
  };
  const logout = async () => {
    // Clears local state even if the server call fails, so the user is never
    // trapped in a session they asked to end.
    try { await apiFetch('/api/auth/logout', { method: 'POST', timeoutMs: WRITE_TIMEOUT_MS }); } catch { /* ignored */ } finally {
      setUser(null); setWorkspaces([]); setDossiers([]); setActiveWorkspaceId(null); setActiveDossierId(null);
    }
  };
  const contextValue = useMemo<AuthContextValue | null>(() => user ? ({
    user, workspaces, dossiers, activeWorkspaceId, activeDossierId,
    activeWorkspace: workspaces.find(item=>item.id===activeWorkspaceId),
    activeDossier: dossiers.find(item=>item.id===activeDossierId),
    selectWorkspace, selectDossier: setActiveDossierId, createDossier, createWorkspace, addWorkspaceMember, refreshDossiers, logout,
  }) : null, [user, workspaces, dossiers, activeWorkspaceId, activeDossierId, refreshDossiers]);

  if (loading) return <div className="auth-loading"><div className="brand-mark">م</div><strong>Mizan</strong><span>Vérification de la session…</span></div>;
  if (!user || !contextValue) return <AuthPage onAuthenticated={refreshSession} initialError={authError}/>;
  return <AuthContext.Provider value={contextValue}>{authError && <div className="status-note" role="alert">{authError}</div>}{loadingDossiers && <div className="session-banner">Chargement des dossiers sécurisés…</div>}{children}</AuthContext.Provider>;
}
