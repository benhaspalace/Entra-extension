import { authorizationCode, createPkce } from '../shared/pkce';
import {
  authScopes,
  readSettings,
  settingsKey,
  type Settings,
} from '../shared/settings';
import type { AuthStatus } from '../shared/messages';

interface TokenSession {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  settingsKey: string;
  sessionId: string;
}

let pending: Promise<TokenSession> | undefined;
let revision = 0;

async function session(): Promise<TokenSession | null> {
  const result = await chrome.storage.session.get('auth');
  return (result.auth as TokenSession | undefined) ?? null;
}

export async function signOut(): Promise<AuthStatus> {
  revision++;
  await chrome.storage.session.clear();
  return { signedIn: false, sessionId: null };
}

export async function authStatus(): Promise<AuthStatus> {
  const current = await session();
  if (!current) return { signedIn: false, sessionId: null };
  const settings = await readSettings();
  const signedIn =
    current.settingsKey === settingsKey(settings) &&
    (current.expiresAt > Date.now() || !!current.refreshToken);
  return { signedIn, sessionId: signedIn ? current.sessionId : null };
}

async function exchange(
  settings: Settings,
  params: URLSearchParams,
  sessionId: string,
  currentRevision: number,
  previousRefreshToken: string | null = null,
): Promise<TokenSession> {
  const response = await fetch(
    `https://login.microsoftonline.com/${settings.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      redirect: 'error',
    },
  );
  if (!response.ok) {
    // Do not surface token endpoint bodies, which may contain sensitive details.
    if (response.status === 400 || response.status === 401) await signOut();
    throw new Error(
      `Sign-in token exchange failed (${response.status}). Sign in again; verify the SPA redirect URI, consent and tenant settings.`,
    );
  }
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== 'object' ||
    !('access_token' in body) ||
    typeof body.access_token !== 'string' ||
    !('expires_in' in body) ||
    !Number.isFinite(Number(body.expires_in)) ||
    Number(body.expires_in) <= 0 ||
    !('token_type' in body) ||
    typeof body.token_type !== 'string' ||
    body.token_type.toLowerCase() !== 'bearer'
  )
    throw new Error(
      'Microsoft returned an invalid token response. Sign in again.',
    );
  if (
    currentRevision !== revision ||
    settingsKey(await readSettings()) !== settingsKey(settings)
  )
    throw new Error('Settings or sign-in state changed. Sign in again.');
  const token: TokenSession = {
    accessToken: body.access_token,
    refreshToken:
      'refresh_token' in body && typeof body.refresh_token === 'string'
        ? body.refresh_token
        : previousRefreshToken,
    expiresAt: Date.now() + Number(body.expires_in) * 1000,
    settingsKey: settingsKey(settings),
    sessionId,
  };
  await chrome.storage.session.set({ auth: token });
  if (currentRevision !== revision) {
    await chrome.storage.session.remove('auth');
    throw new Error('Sign-in state changed. Sign in again.');
  }
  return token;
}

async function interactive(): Promise<TokenSession> {
  const settings = await readSettings();
  const currentRevision = revision;
  const pkce = await createPkce();
  const redirect = chrome.identity.getRedirectURL();
  const authorize = new URL(
    `https://login.microsoftonline.com/${settings.tenantId}/oauth2/v2.0/authorize`,
  );
  authorize.search = new URLSearchParams({
    client_id: settings.clientId,
    response_type: 'code',
    redirect_uri: redirect,
    response_mode: 'query',
    scope: authScopes(settings),
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    prompt: 'select_account',
  }).toString();
  const callback = await chrome.identity.launchWebAuthFlow({
    url: authorize.href,
    interactive: true,
  });
  if (!callback) throw new Error('Microsoft sign-in was cancelled.');
  const code = authorizationCode(callback, redirect, pkce.state);
  await chrome.storage.session.remove('packageCache');
  return exchange(
    settings,
    new URLSearchParams({
      client_id: settings.clientId,
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce.verifier,
      redirect_uri: redirect,
      scope: authScopes(settings),
    }),
    crypto.randomUUID(),
    currentRevision,
  );
}

async function exclusive(
  operation: () => Promise<TokenSession>,
): Promise<TokenSession> {
  if (pending) return pending;
  pending = operation();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}

export async function signIn(): Promise<AuthStatus> {
  const token = await exclusive(interactive);
  return { signedIn: true, sessionId: token.sessionId };
}

export async function getToken(forceRefresh: boolean): Promise<string> {
  if (pending) return (await pending).accessToken;
  const settings = await readSettings();
  const cached = await session();
  if (!cached || cached.settingsKey !== settingsKey(settings))
    throw new Error('Sign in to Microsoft Entra to continue.');
  if (!forceRefresh && cached.expiresAt > Date.now() + 60_000)
    return cached.accessToken;
  const token = await exclusive(async () => {
    const settings = await readSettings();
    const currentRevision = revision;
    const current = await session();
    if (!current || current.settingsKey !== settingsKey(settings))
      throw new Error('Sign in to Microsoft Entra to continue.');
    if (!forceRefresh && current.expiresAt > Date.now() + 60_000)
      return current;
    if (!current.refreshToken) {
      await signOut();
      throw new Error('Your session expired. Sign in again.');
    }
    return exchange(
      settings,
      new URLSearchParams({
        client_id: settings.clientId,
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        scope: authScopes(settings),
      }),
      current.sessionId,
      currentRevision,
      current.refreshToken,
    );
  });
  return token.accessToken;
}
