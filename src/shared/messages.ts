import type { UserAccessPackages } from './types';

export interface AuthStatus {
  signedIn: boolean;
  sessionId: string | null;
}

interface Requests {
  signIn: undefined;
  signOut: undefined;
  authStatus: undefined;
  getToken: { refresh: boolean };
  getUserAccessPackages: { userId: string };
  openSidePanel: undefined;
}

interface Results {
  signIn: AuthStatus;
  signOut: AuthStatus;
  authStatus: AuthStatus;
  getToken: string;
  getUserAccessPackages: UserAccessPackages;
  openSidePanel: null;
}

export type Request = {
  [K in keyof Requests]: { type: K; payload: Requests[K] };
}[keyof Requests];

export type Response<T> = { ok: true; value: T } | { ok: false; error: string };

export async function request<K extends keyof Requests>(
  type: K,
  payload: Requests[K],
): Promise<Results[K]> {
  const response: Response<Results[K]> = await chrome.runtime.sendMessage({
    type,
    payload,
  });
  if (!response?.ok)
    throw new Error(
      response?.error ?? 'The extension background worker is unavailable.',
    );
  return response.value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'An unexpected extension error occurred.';
}
