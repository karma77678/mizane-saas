/**
 * Single entry point for calls to the Mizan API.
 *
 * Every request is bounded by a deadline. `fetch` has no default timeout, so
 * an API that stops answering — a blocked PostgreSQL port, a paused database,
 * a dev proxy with a dead upstream — leaves the promise pending forever and
 * the confirm button spinning with nothing to click. Here, every call ends in
 * a resolved value or a readable `ApiError`.
 */

/** Reads. Short: these should be fast or be reported as broken. */
export const READ_TIMEOUT_MS = 30_000;
/** Ordinary writes (status changes, settings, constat sync). */
export const WRITE_TIMEOUT_MS = 60_000;
/** Structured file imports: a large JSONB payload legitimately takes longer. */
export const IMPORT_TIMEOUT_MS = 180_000;
/** Model calls are slow, but still bounded. */
export const AI_TIMEOUT_MS = 120_000;

export class ApiError extends Error {
  readonly status: number;
  /** True when nothing was received at all (offline, DNS, dead proxy). */
  readonly offline: boolean;
  /** True when the deadline elapsed before the server answered. */
  readonly timedOut: boolean;
  /** Seconds the server asked to wait (Retry-After on a 429), else null. */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: { status?: number; offline?: boolean; timedOut?: boolean; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.offline = options.offline ?? false;
    this.timedOut = options.timedOut ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

type ApiRequest = Omit<RequestInit, 'signal'> & { timeoutMs?: number };

/**
 * Performs the request and normalises every failure mode into `ApiError`.
 * Never resolves with a non-2xx response: callers only handle success.
 */
export async function apiFetch(path: string, init: ApiRequest = {}): Promise<Response> {
  const { timeoutMs = READ_TIMEOUT_MS, ...rest } = init;

  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      credentials: 'include',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbort(error)) {
      throw new ApiError(
        `Le serveur n’a pas répondu dans le délai imparti (${Math.round(timeoutMs / 1000)} s). ` +
          'Vérifiez la connexion à PostgreSQL — certains réseaux d’entreprise bloquent le port de la base — puis réessayez.',
        { timedOut: true },
      );
    }
    throw new ApiError(
      'Le serveur Mizan est injoignable. L’opération n’a pas été enregistrée.',
      { offline: true },
    );
  }

  if (response.ok) return response;

  // The API answers errors as JSON; fall back gracefully if a proxy or a
  // crash returned HTML instead.
  let serverMessage = '';
  try {
    const payload = (await response.clone().json()) as { error?: unknown };
    if (typeof payload?.error === 'string') serverMessage = payload.error;
  } catch {
    serverMessage = '';
  }

  const fallback =
    response.status === 401
      ? 'Votre session a expiré. Reconnectez-vous puis relancez l’opération.'
      : response.status === 403
        ? 'Accès refusé pour ce dossier.'
        : response.status === 413
          ? 'Le volume de données dépasse la limite autorisée par le serveur.'
          : response.status === 429
            ? 'Trop de requêtes en peu de temps. Patientez puis réessayez.'
            : response.status >= 500
              ? `Le serveur a renvoyé une erreur (${response.status}). L’opération n’a pas été enregistrée.`
              : `La requête a été refusée (${response.status}).`;

  const retryAfter = Number(response.headers.get('Retry-After'));
  throw new ApiError(serverMessage || fallback, {
    status: response.status,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  });
}

/** Same guarantees as `apiFetch`, plus a parsed JSON body. */
export async function apiJson<T>(path: string, init: ApiRequest = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError('La réponse du serveur est illisible (JSON invalide).', {
      status: response.status,
    });
  }
}

/** JSON body plus the headers the API expects, in one place. */
export function jsonBody(payload: unknown): ApiRequest {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

/** Message for any thrown value, so no catch block can swallow a cause. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
