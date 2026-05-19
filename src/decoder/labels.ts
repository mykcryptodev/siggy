/**
 * Address label enrichment — resolves addresses to human-readable names.
 *
 * Priority order:
 * 1. Known contracts (curated hardcoded list, per-chain)
 * 2. Zapper GraphQL API (ENS, Farcaster, Lens, Basenames, display names — all in one call)
 * 3. ENS reverse resolution via mainnet viem (catches primary names Zapper misses)
 * 4. Thirdweb social profiles (Farcaster, Lens, ENS fallback)
 * 5. Shortened address fallback
 */

import { createThirdwebClient } from 'thirdweb';
import { getSocialProfiles } from 'thirdweb/social';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import type { Address } from 'viem';

// ─────────────────────────────────────────────
// Curated known address labels (chain-specific)
// ─────────────────────────────────────────────

const KNOWN_LABELS: Record<number, Record<string, string>> = {
  // All chains (chainId 0 = global)
  0: {
    '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
  },
  // Ethereum mainnet
  1: {
    '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
    '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap Universal Router',
    '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'Uniswap Universal Router v1.2',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router v1.3',
    '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch v5',
    '0x1111111254fb6c44bac0bed2854e76f90643097d': '1inch v4',
    '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'Sushiswap Router',
    '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
    '0x00000000219ab540356cbb839cbe05303d7705fa': 'ETH2 Deposit Contract',
    '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': 'stETH (Lido)',
    '0xdc24316b9ae028f1497c275eb9192a3ea0f67022': 'Curve stETH Pool',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
    '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf': 'Polygon Bridge',
  },
  // Base
  8453: {
    '0xf142022273602c6a6c0ea7a044d21082273bd686': 'myk × clawd Safe',
    '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
    '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24': 'Uniswap V2 Router',
    '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap V3 Router',
    '0x198ef1ec325a96cc354c7266a038be8b5c558f67': 'Aerodrome Router',
    '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aerodrome Factory',
    '0x4200000000000000000000000000000000000010': 'Base L2StandardBridge',
    '0x4200000000000000000000000000000000000006': 'WETH (Base)',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI (Base)',
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC',
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'cbETH',
    '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'AERO',
    '0x532f27101965dd16442e59d40670faf5ebb142e4': 'BRETT',
    '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch v5',
    '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
  },
  // Optimism
  10: {
    '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
    '0x4a7b5da61326a6379179b40d00f57da73bbfcef7': 'Velodrome Router',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
    '0x4200000000000000000000000000000000000006': 'WETH (OP)',
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'USDC (OP)',
    '0x9560e827af36c94d2ac33a39bce1fe78631088db': 'VELO',
  },
  // Arbitrum
  42161: {
    '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC (Arb)',
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH (Arb)',
  },
  // Polygon
  137: {
    '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'USDC (Polygon)',
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': 'WETH (Polygon)',
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 'WMATIC',
  },
  // Gnosis
  100: {
    '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
    '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d': 'WXDAI',
    '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83': 'USDC (Gnosis)',
  },
};

// ─────────────────────────────────────────────
// Zapper GraphQL (EOA identity resolution)
// ─────────────────────────────────────────────

const ZAPPER_API_KEY = process.env.ZAPPER_API_KEY ?? '17697de5-6320-4b48-9ce1-98e240ee0cc1';
const ZAPPER_GRAPHQL = 'https://public.zapper.xyz/graphql';

const ZAPPER_QUERY = `
  query AccountIdentity($addresses: [Address!]!) {
    accounts(addresses: $addresses) {
      displayName { source value }
      ensRecord { name }
      basename
      farcasterProfile { username }
      lensProfile { handle }
    }
  }
`;

interface ZapperAccount {
  displayName?: { source: string; value: string };
  ensRecord?: { name: string };
  basename?: string;
  farcasterProfile?: { username: string };
  lensProfile?: { handle: string };
}

async function zapperBatchResolve(addresses: string[]): Promise<Record<string, string>> {
  if (!addresses.length) return {};
  try {
    const resp = await fetch(ZAPPER_GRAPHQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-zapper-api-key': ZAPPER_API_KEY,
      },
      body: JSON.stringify({ query: ZAPPER_QUERY, variables: { addresses } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return {};
    const json = await resp.json() as { data?: { accounts?: ZapperAccount[] } };
    const accounts = json.data?.accounts ?? [];
    const result: Record<string, string> = {};
    addresses.forEach((addr, i) => {
      const a = accounts[i];
      if (!a) return;
      // Zapper returns source as "ADDRESS" (uppercase) when no identity found — normalise before comparing
      const source = a.displayName?.source?.toLowerCase();
      if (a.displayName?.value && source !== 'address') {
        result[addr.toLowerCase()] = a.displayName.value;
      } else if (a.farcasterProfile?.username) {
        result[addr.toLowerCase()] = `@${a.farcasterProfile.username}`;
      } else if (a.lensProfile?.handle) {
        result[addr.toLowerCase()] = a.lensProfile.handle;
      } else if (a.ensRecord?.name) {
        result[addr.toLowerCase()] = a.ensRecord.name;
      } else if (a.basename) {
        result[addr.toLowerCase()] = a.basename;
      }
    });
    return result;
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────
// ENS reverse resolution via mainnet viem client
// ─────────────────────────────────────────────

let ensClient: ReturnType<typeof createPublicClient> | null = null;
function getEnsClient() {
  if (!ensClient) {
    ensClient = createPublicClient({ chain: mainnet, transport: http('https://cloudflare-eth.com') });
  }
  return ensClient;
}

async function ensResolve(address: string): Promise<string | null> {
  try {
    const client = getEnsClient();
    const name = await client.getEnsName({ address: address as Address });
    return name ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Thirdweb social profiles (fallback)
// ─────────────────────────────────────────────

const THIRDWEB_CLIENT_ID = process.env.THIRDWEB_CLIENT_ID ?? '856567926d85c87c4aa2c7162f4c95be';

let twClient: ReturnType<typeof createThirdwebClient> | null = null;
function getThirdwebClient() {
  if (!twClient) {
    twClient = createThirdwebClient({ clientId: THIRDWEB_CLIENT_ID });
  }
  return twClient;
}

async function thirdwebResolve(address: string): Promise<string | null> {
  try {
    const client = getThirdwebClient();
    const profiles = await getSocialProfiles({ address: address as Address, client });
    const best =
      profiles.find((p) => p.type === 'farcaster') ??
      profiles.find((p) => p.type === 'lens') ??
      profiles.find((p) => p.type === 'ens');
    return best?.name ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// In-memory cache
// ─────────────────────────────────────────────

const labelCache = new Map<string, string>();

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export function shortenAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Resolve a single address to the best human-readable label.
 */
export async function labelAddress(
  address: string,
  chainId: number,
  resolve = true,
): Promise<string> {
  const lower = address.toLowerCase();

  // 1. Chain-specific known label
  if (KNOWN_LABELS[chainId]?.[lower]) return KNOWN_LABELS[chainId][lower];
  // 2. Global known label
  if (KNOWN_LABELS[0]?.[lower]) return KNOWN_LABELS[0][lower];

  if (!resolve) return shortenAddress(address);

  // 3. Cache
  const cacheKey = `${chainId}:${lower}`;
  if (labelCache.has(cacheKey)) return labelCache.get(cacheKey)!;

  // 4. Zapper (best single source — covers ENS, Farcaster, Lens, Basenames)
  const zapperResults = await zapperBatchResolve([address]);
  if (zapperResults[lower]) {
    labelCache.set(cacheKey, zapperResults[lower]);
    return zapperResults[lower];
  }

  // 5. ENS reverse resolution (catches primary names Zapper missed)
  const ens = await ensResolve(address);
  if (ens) {
    labelCache.set(cacheKey, ens);
    return ens;
  }

  // 6. Thirdweb social profiles fallback
  const tw = await thirdwebResolve(address);
  if (tw) {
    labelCache.set(cacheKey, tw);
    return tw;
  }

  // 7. Shortened address
  const short = shortenAddress(address);
  labelCache.set(cacheKey, short);
  return short;
}

/**
 * Batch-resolve multiple addresses efficiently (single Zapper call for all unknowns).
 */
export async function labelAddresses(
  addresses: string[],
  chainId: number,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const needsResolution: string[] = [];

  for (const addr of addresses) {
    const lower = addr.toLowerCase();
    // Check known labels first
    if (KNOWN_LABELS[chainId]?.[lower]) { result[addr] = KNOWN_LABELS[chainId][lower]; continue; }
    if (KNOWN_LABELS[0]?.[lower]) { result[addr] = KNOWN_LABELS[0][lower]; continue; }
    const cacheKey = `${chainId}:${lower}`;
    if (labelCache.has(cacheKey)) { result[addr] = labelCache.get(cacheKey)!; continue; }
    needsResolution.push(addr);
  }

  if (needsResolution.length > 0) {
    // Single Zapper batch call for all unknowns
    const zapperResults = await zapperBatchResolve(needsResolution);

    // ENS + Thirdweb fallback for those Zapper couldn't resolve
    await Promise.all(needsResolution.map(async (addr) => {
      const lower = addr.toLowerCase();
      const cacheKey = `${chainId}:${lower}`;
      if (zapperResults[lower]) {
        result[addr] = zapperResults[lower];
        labelCache.set(cacheKey, zapperResults[lower]);
      } else {
        // ENS reverse lookup before thirdweb
        const ens = await ensResolve(addr);
        if (ens) {
          result[addr] = ens;
          labelCache.set(cacheKey, ens);
          return;
        }
        const tw = await thirdwebResolve(addr);
        const label = tw ?? shortenAddress(addr);
        result[addr] = label;
        labelCache.set(cacheKey, label);
      }
    }));
  }

  return result;
}
