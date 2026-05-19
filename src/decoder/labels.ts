/**
 * Address label enrichment — resolves addresses to human-readable names.
 *
 * Priority order:
 * 1. Known contracts (curated hardcoded list, per-chain)
 * 2. ENS primary name (mainnet only, via public RPC)
 * 3. Basenames (Base chain, via L2 resolver)
 * 4. Shortened address fallback
 */

import { createPublicClient, http, type Address, parseAbi } from 'viem';

// ─────────────────────────────────────────────
// Curated known address labels (chain-specific)
// ─────────────────────────────────────────────

// Format: { [chainId]: { [addressLowercase]: label } }
const KNOWN_LABELS: Record<number, Record<string, string>> = {
  // All chains — Permit2 is deployed at same address everywhere
  0: {
    '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
    '0x000000000022d473030f116ddee9f6b43ac78ba4': 'Permit2',
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
    '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419': 'Chainlink ETH/USD',
    '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf': 'Polygon Bridge',
    '0xa58d7a5f0e11c1c50e47416b48caf8e0b3f5b7e0': 'Arbitrum Bridge',
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
    '0x6200000000000000000000000000000000000001': 'Base Bridge (L2StandardBridge)',
    '0x4200000000000000000000000000000000000010': 'Base L2StandardBridge',
    '0x4200000000000000000000000000000000000006': 'WETH (Base)',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC (Base)',
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI (Base)',
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC',
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'cbETH',
    '0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4': 'toshi',
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
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e (Arb)',
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
// ENS resolution (mainnet)
// ─────────────────────────────────────────────

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as Address;
const ENS_REVERSE_RESOLVER_ABI = parseAbi([
  'function getNames(address[]) view returns (string[])',
]);
const ENS_BATCH_RESOLVER = '0x3671aE578E63FdF66ad4F3E12CC0c0d71Ac7510C' as Address; // off-chain multicall

// Basename L2 resolver on Base
const BASENAME_L2_RESOLVER = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD' as Address;
const BASENAME_RESOLVER_ABI = parseAbi([
  'function getNames(address[]) view returns (string[])',
]);

const ensCache = new Map<string, string | null>(); // address → name or null

async function resolveEns(address: string): Promise<string | null> {
  const key = `ens:${address.toLowerCase()}`;
  if (ensCache.has(key)) return ensCache.get(key) ?? null;

  try {
    const client = createPublicClient({
      transport: http('https://cloudflare-eth.com'),
    });

    const names = await client.readContract({
      address: ENS_BATCH_RESOLVER,
      abi: ENS_REVERSE_RESOLVER_ABI,
      functionName: 'getNames',
      args: [[address as Address]],
    });

    const name = names[0] || null;
    ensCache.set(key, name);
    return name;
  } catch {
    ensCache.set(key, null);
    return null;
  }
}

async function resolveBasename(address: string): Promise<string | null> {
  const key = `base:${address.toLowerCase()}`;
  if (ensCache.has(key)) return ensCache.get(key) ?? null;

  try {
    const client = createPublicClient({
      transport: http('https://mainnet.base.org'),
    });

    const names = await client.readContract({
      address: BASENAME_L2_RESOLVER,
      abi: BASENAME_RESOLVER_ABI,
      functionName: 'getNames',
      args: [[address as Address]],
    });

    const name = names[0] || null;
    ensCache.set(key, name);
    return name;
  } catch {
    ensCache.set(key, null);
    return null;
  }
}

// ─────────────────────────────────────────────
// Main enrichment function
// ─────────────────────────────────────────────

export function shortenAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Resolve an address to the best human-readable label.
 * Returns the label if found, otherwise a shortened address.
 *
 * @param address  EVM address (any case)
 * @param chainId  Chain to check known labels for
 * @param resolve  Whether to attempt ENS/Basename resolution (slower, async)
 */
export async function labelAddress(
  address: string,
  chainId: number,
  resolve = true,
): Promise<string> {
  const lower = address.toLowerCase();

  // 1. Check chain-specific known labels
  const chainLabels = KNOWN_LABELS[chainId] ?? {};
  if (chainLabels[lower]) return chainLabels[lower];

  // 2. Check cross-chain known labels (chainId 0 = all chains)
  const globalLabels = KNOWN_LABELS[0] ?? {};
  if (globalLabels[lower]) return globalLabels[lower];

  if (!resolve) return shortenAddress(address);

  // 3. Try Basename (Base chain — fast, most relevant for Base users)
  if (chainId === 8453) {
    const basename = await resolveBasename(address);
    if (basename) return basename;
  }

  // 4. Try ENS (mainnet or any chain — use for EOA addresses)
  const ens = await resolveEns(address);
  if (ens) return ens;

  // 5. Fallback to shortened address
  return shortenAddress(address);
}

/**
 * Enrich multiple addresses at once (parallel resolution).
 */
export async function labelAddresses(
  addresses: string[],
  chainId: number,
): Promise<Record<string, string>> {
  const results = await Promise.all(
    addresses.map(async (addr) => [addr, await labelAddress(addr, chainId)] as [string, string]),
  );
  return Object.fromEntries(results);
}
