import { vi } from 'vitest';

export const settings = {
  tenantId: '12345678-1234-4abc-8def-123456789abc',
  clientId: '87654321-4321-4abc-8def-123456789abc',
  auditEnabled: true,
};

export function storageArea(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = structuredClone(initial);
  return {
    values,
    get: vi.fn(async (key: string) => ({
      [key]: structuredClone(values[key]),
    })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, structuredClone(items));
    }),
    remove: vi.fn(async (key: string) => {
      delete values[key];
    }),
    clear: vi.fn(async () => {
      for (const key of Object.keys(values)) delete values[key];
    }),
  };
}

export function mockChrome() {
  const session = storageArea();
  const sync = storageArea({ settings });
  const local = storageArea();
  const launchWebAuthFlow = vi.fn(async ({ url }: { url: string }) => {
    const authorize = new URL(url);
    return `https://extension.chromiumapp.org/?code=authorization-code&state=${authorize.searchParams.get('state')}`;
  });
  vi.stubGlobal('chrome', {
    storage: { session, sync, local },
    identity: {
      getRedirectURL: () => 'https://extension.chromiumapp.org/',
      launchWebAuthFlow,
    },
  });
  return { session, sync, local, launchWebAuthFlow };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
