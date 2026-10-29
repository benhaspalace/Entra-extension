import type { GraphClient } from './graph';
import type { AccessPackage } from './types';

export const ENTITLEMENTS = '/identityGovernance/entitlementManagement';
export const PACKAGE_SCOPE = 'EntitlementManagement.Read.All';

interface PackageCache {
  sessionId: string;
  expiresAt: number;
  packages: AccessPackage[];
}

export async function loadPackages(
  graph: GraphClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<AccessPackage[]> {
  const stored = await chrome.storage.session.get('packageCache');
  const cache = stored.packageCache as PackageCache | undefined;
  if (cache?.sessionId === sessionId && cache.expiresAt > Date.now())
    return cache.packages;

  // Expanded relationship collections can themselves be paged.
  const packages = await graph.list<AccessPackage>(
    `${ENTITLEMENTS}/accessPackages?$expand=resourceRoleScopes($expand=role,scope)&$select=id,displayName`,
    PACKAGE_SCOPE,
    signal,
  );
  const complete = await mapLimited(packages, 4, async (pkg) => {
    if (!pkg['resourceRoleScopes@odata.nextLink']) return pkg;
    return {
      ...pkg,
      resourceRoleScopes: await graph.list<
        NonNullable<AccessPackage['resourceRoleScopes']>[number]
      >(
        `${ENTITLEMENTS}/accessPackages/${encodeURIComponent(pkg.id)}/resourceRoleScopes?$expand=role,scope`,
        PACKAGE_SCOPE,
        signal,
      ),
    };
  });
  signal.throwIfAborted();
  const auth = await chrome.storage.session.get('auth');
  const current = auth.auth as { sessionId?: string } | undefined;
  if (current?.sessionId === sessionId) {
    try {
      await chrome.storage.session.set({
        packageCache: {
          sessionId,
          expiresAt: Date.now() + 15 * 60_000,
          packages: complete,
        } satisfies PackageCache,
      });
    } catch {
      console.warn(
        'Access package cache could not be saved to session storage.',
      );
    }
  }
  return complete;
}

export async function mapLimited<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('Concurrency must be a positive integer.');
  const results: R[] = new Array(items.length);
  const pending = items.entries();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (const [index, item] of pending) {
        results[index] = await operation(item);
      }
    }),
  );
  return results;
}
