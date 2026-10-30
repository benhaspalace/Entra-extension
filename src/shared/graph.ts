const ROOT = 'https://graph.microsoft.com/v1.0';

export class GraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly scope: string,
  ) {
    super(
      status === 401
        ? 'Your session expired. Sign in again.'
        : status === 403
          ? `Missing permission or directory role: ${scope}. Grant admin consent and verify your directory role.`
          : `Microsoft Graph request failed (${status}, ${code}).`,
    );
    this.name = 'GraphError';
  }
}

interface Page<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

function needsEventualConsistency(url: string): boolean {
  const parsed = new URL(url);
  return (
    parsed.pathname.includes('/microsoft.graph.') ||
    parsed.searchParams.get('$count') === 'true'
  );
}

export function graphUrl(path: string): string {
  const url = new URL(path.startsWith('/') ? `${ROOT}${path}` : path);
  if (
    url.origin !== 'https://graph.microsoft.com' ||
    !url.pathname.startsWith('/v1.0/') ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('Rejected a Graph URL outside the Graph v1.0 endpoint.');
  return url.href;
}

export function retryDelay(
  value: string | null,
  attempt: number,
  now = Date.now(),
): number {
  let delay = Math.min(1000 * 2 ** attempt, 30_000);
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) delay = seconds * 1000;
    else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) delay = Math.max(0, date - now);
    }
  }
  if (delay > 60_000)
    throw new Error(
      'Microsoft Graph throttling requires a wait longer than 60 seconds. Try again later.',
    );
  return delay;
}

export interface GraphClient {
  graphFetch<T>(path: string, scope: string, signal?: AbortSignal): Promise<T>;
  list<T>(path: string, scope: string, signal?: AbortSignal): Promise<T[]>;
}

export function createGraphClient(
  getToken: (refresh: boolean) => Promise<string>,
  fetcher: typeof fetch = fetch,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
): GraphClient {
  async function graphFetch<T>(
    path: string,
    scope: string,
    signal?: AbortSignal,
    eventual = false,
  ): Promise<T> {
    const url = graphUrl(path);
    signal?.throwIfAborted();
    let refreshed = false;
    let token = await getToken(false);
    let retries = 0;
    while (true) {
      signal?.throwIfAborted();
      const response = await fetcher(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(eventual || needsEventualConsistency(url)
            ? { ConsistencyLevel: 'eventual' }
            : {}),
        },
        redirect: 'error',
        ...(signal ? { signal } : {}),
      });
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        token = await getToken(true);
        continue;
      }
      if ((response.status === 429 || response.status === 503) && retries < 4) {
        await sleep(
          retryDelay(response.headers.get('Retry-After'), retries++),
          signal,
        );
        continue;
      }
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const code =
          body &&
          typeof body === 'object' &&
          'error' in body &&
          body.error &&
          typeof body.error === 'object' &&
          'code' in body.error &&
          typeof body.error.code === 'string'
            ? body.error.code
            : 'RequestFailed';
        throw new GraphError(response.status, code, scope);
      }
      return (await response.json()) as T;
    }
  }

  async function list<T>(
    path: string,
    scope: string,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const values: T[] = [];
    const visited = new Set<string>();
    const eventual = needsEventualConsistency(graphUrl(path));
    let next: string | undefined = path;
    while (next) {
      const url = graphUrl(next);
      if (visited.has(url))
        throw new Error('Microsoft Graph returned a paging loop.');
      visited.add(url);
      const page: Page<T> = await graphFetch<Page<T>>(
        url,
        scope,
        signal,
        eventual,
      );
      if (
        !Array.isArray(page.value) ||
        (page['@odata.nextLink'] !== undefined &&
          typeof page['@odata.nextLink'] !== 'string')
      )
        throw new Error('Microsoft Graph returned an invalid list response.');
      values.push(...page.value);
      next = page['@odata.nextLink'];
    }
    return values;
  }
  return { graphFetch, list };
}
