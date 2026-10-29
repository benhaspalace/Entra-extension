import { describe, expect, it, vi } from 'vitest';
import {
  createGraphClient,
  GraphError,
  graphUrl,
  retryDelay,
} from '../src/shared/graph';

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    ...(headers ? { headers } : {}),
  });

describe('Graph paging and authentication', () => {
  it('follows every continuation, including an empty middle page and opaque query', async () => {
    const next = 'https://graph.microsoft.com/v1.0/groups?$skiptoken=A%2FB%2BC';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ value: [{ id: '1' }], '@odata.nextLink': next }),
      )
      .mockResolvedValueOnce(json({ value: [], '@odata.nextLink': `${next}2` }))
      .mockResolvedValueOnce(json({ value: [{ id: '2' }] }));
    const client = createGraphClient(async () => 'test-token', fetcher);
    expect(await client.list('/groups', 'GroupMember.Read.All')).toEqual([
      { id: '1' },
      { id: '2' },
    ]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://graph.microsoft.com/v1.0/groups',
      next,
      `${next}2`,
    ]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer test-token' },
      redirect: 'error',
    });
  });

  it('rejects malicious continuations before getting a token or fetching them', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ value: [], '@odata.nextLink': 'https://evil.example/steal' }),
      );
    const token = vi.fn(async () => 'test-token');
    await expect(
      createGraphClient(token, fetcher).list('/groups', 'scope'),
    ).rejects.toThrow('Rejected');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(token).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://graph.microsoft.com.evil.example/v1.0/groups',
    'http://graph.microsoft.com/v1.0/groups',
    'https://graph.microsoft.com/beta/groups',
    'https://username@graph.microsoft.com/v1.0/groups',
    'https://login.microsoftonline.com/v1.0/groups',
    'https://graph.microsoft.com/v1.0/groups#fragment',
  ])('rejects non-v1.0 Graph URL %s', (url) => {
    expect(() => graphUrl(url)).toThrow('Rejected');
  });

  it('detects loops and malformed pages instead of returning partial data', async () => {
    const loop = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        value: [],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups',
      }),
    );
    await expect(
      createGraphClient(async () => 't', loop).list('/groups', 's'),
    ).rejects.toThrow('paging loop');
    for (const response of [
      {},
      { value: null },
      { value: [], '@odata.nextLink': 42 },
    ]) {
      await expect(
        createGraphClient(
          async () => 't',
          vi.fn<typeof fetch>().mockResolvedValue(json(response)),
        ).list('/groups', 's'),
      ).rejects.toThrow('invalid list');
    }
  });

  it('refreshes once on 401, then reuses that token on a transient retry', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({}, 503, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(json({ value: [] }));
    const token = vi.fn(async (refresh: boolean) =>
      refresh ? 'fresh' : 'old',
    );
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(
      async () => {},
    );
    await createGraphClient(token, fetcher, sleep).list('/groups', 's');
    expect(token.mock.calls).toEqual([[false], [true]]);
    expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer fresh',
    });
    expect(sleep).toHaveBeenCalledWith(1000, undefined);
  });

  it('emits typed 401 and 403 errors with the requested scope', async () => {
    for (const status of [401, 403]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          json({ error: { code: 'Denied' } }, status),
        );
      const result = createGraphClient(async () => 't', fetcher).graphFetch(
        '/groups',
        'EntitlementManagement.Read.All',
      );
      await expect(result).rejects.toMatchObject({
        status,
        code: 'Denied',
        scope: 'EntitlementManagement.Read.All',
      });
      await expect(result).rejects.toBeInstanceOf(GraphError);
      if (status === 403)
        await expect(result).rejects.toThrow('EntitlementManagement.Read.All');
      expect(fetcher).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
    }
  });

  it('honors Retry-After for 429 and caps attempts at five', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({}, 429, { 'Retry-After': '2' }));
    const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(
      async () => {},
    );
    await expect(
      createGraphClient(async () => 't', fetcher, sleep).list('/groups', 's'),
    ).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.every((args) => args[0] === 2000)).toBe(true);
  });

  it('supports date, numeric and missing Retry-After', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    expect(retryDelay('Thu, 01 Oct 2026 00:00:03 GMT', 0, now)).toBe(3000);
    expect(retryDelay('0', 0, now)).toBe(0);
    expect(retryDelay('2.5', 0, now)).toBe(2500);
    expect(retryDelay('bad', 2, now)).toBe(4000);
    expect(retryDelay(null, 10, now)).toBe(30_000);
    expect(retryDelay('Wed, 30 Sep 2026 00:00:00 GMT', 0, now)).toBe(0);
  });

  it('allows waits up to exactly 60 seconds and rejects longer numeric or date waits', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    expect(retryDelay('60', 0, now)).toBe(60_000);
    expect(retryDelay('Thu, 01 Oct 2026 00:01:00 GMT', 0, now)).toBe(60_000);
    expect(() => retryDelay('60.001', 0, now)).toThrow('throttling');
    expect(() => retryDelay('Thu, 01 Oct 2026 00:01:01 GMT', 0, now)).toThrow(
      'throttling',
    );
  });

  it.each([429, 503])(
    'does not sleep or retry when %s requires more than 60 seconds',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({}, status, { 'Retry-After': '61' }));
      const sleep = vi.fn(async () => {});
      await expect(
        createGraphClient(async () => 't', fetcher, sleep).list('/groups', 's'),
      ).rejects.toThrow('throttling');
      expect(sleep).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('sends advanced query headers for cast membership requests', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ value: [] }));
    await createGraphClient(async () => 't', fetcher).list(
      '/users/u/memberOf/microsoft.graph.group?$count=true',
      's',
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      ConsistencyLevel: 'eventual',
    });
  });

  it('cancels retries and does not fetch with an already aborted signal', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      return json({}, 503);
    });
    await expect(
      createGraphClient(async () => 't', fetcher).list(
        '/groups',
        's',
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await expect(
      createGraphClient(async () => 't', fetcher).list(
        '/groups',
        's',
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
