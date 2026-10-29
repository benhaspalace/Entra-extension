export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function createPkce(): Promise<{
  verifier: string;
  challenge: string;
  state: string;
}> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
  return {
    verifier,
    challenge,
    state: base64Url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

export function authorizationCode(
  callback: string,
  redirectUri: string,
  expectedState: string,
): string {
  const result = new URL(callback);
  const redirect = new URL(redirectUri);
  if (
    result.origin !== redirect.origin ||
    result.pathname !== redirect.pathname ||
    result.searchParams.get('state') !== expectedState
  )
    throw new Error('Sign-in redirect or state validation failed.');
  if (result.searchParams.has('error'))
    throw new Error('Microsoft sign-in was cancelled or denied. Try again.');
  const code = result.searchParams.get('code');
  if (!code)
    throw new Error('Microsoft sign-in did not return an authorization code.');
  return code;
}
