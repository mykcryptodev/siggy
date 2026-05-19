import { createPublicClient, http, type Address, type Hex, parseAbi, formatUnits } from 'viem';
import { getChain } from '../chains.js';
import { labelAddress, shortenAddress } from './labels.js';

// ERC-20 function selectors
export const ERC20_SELECTORS = {
  transfer: '0xa9059cbb',
  transferFrom: '0x23b872dd',
  approve: '0x095ea7b3',
} as const;

export type Erc20Selector = (typeof ERC20_SELECTORS)[keyof typeof ERC20_SELECTORS];

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
]);

// Simple in-memory token cache to avoid redundant RPC calls
const tokenCache = new Map<string, { symbol: string; decimals: number } | null>();

export async function fetchTokenInfo(
  tokenAddress: Address,
  chainId: number,
): Promise<{ symbol: string; decimals: number } | null> {
  const cacheKey = `${chainId}:${tokenAddress.toLowerCase()}`;
  if (tokenCache.has(cacheKey)) {
    return tokenCache.get(cacheKey) ?? null;
  }

  try {
    const chain = getChain(chainId);
    const client = createPublicClient({
      transport: http(chain.rpcUrl),
    });

    const [symbol, decimals] = await Promise.all([
      client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }),
      client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
    ]);

    const info = { symbol: symbol as string, decimals: decimals as number };
    tokenCache.set(cacheKey, info);
    return info;
  } catch {
    tokenCache.set(cacheKey, null);
    return null;
  }
}

function formatTokenAmount(raw: bigint, decimals: number, symbol: string): string {
  const formatted = formatUnits(raw, decimals);
  // Round to at most 6 decimal places for readability
  const num = parseFloat(formatted);
  const display = num >= 1 ? num.toLocaleString('en-US', { maximumFractionDigits: 4 }) : formatted;
  return `${display} ${symbol}`;
}

export interface Erc20DecodeResult {
  summary: string;
  type: 'erc20_transfer' | 'erc20_approve';
  warnings?: string[];
}

/**
 * Decode ERC-20 transfer(address,uint256)
 * Selector: 0xa9059cbb
 */
export async function decodeErc20Transfer(
  calldata: Hex,
  tokenAddress: Address,
  chainId: number,
): Promise<Erc20DecodeResult | null> {
  // Expect at least 4 (selector) + 32 (address padded) + 32 (uint256) = 68 bytes
  if (calldata.length < 138) return null;

  const selector = calldata.slice(0, 10).toLowerCase();
  if (selector !== ERC20_SELECTORS.transfer) return null;

  try {
    // Remove selector, parse address (last 20 bytes of first 32-byte word) and amount
    const data = calldata.slice(10);
    const recipientPadded = data.slice(0, 64);
    const amountHex = data.slice(64, 128);

    const recipient = `0x${recipientPadded.slice(24)}` as Address;
    const amount = BigInt(`0x${amountHex}`);

    const tokenInfo = await fetchTokenInfo(tokenAddress, chainId);

    let amountStr: string;
    if (tokenInfo) {
      amountStr = formatTokenAmount(amount, tokenInfo.decimals, tokenInfo.symbol);
    } else {
      amountStr = `${amount.toString()} (raw units) of ${shortenAddress(tokenAddress)}`;
    }

    const recipientLabel = await labelAddress(recipient, chainId);
    return {
      type: 'erc20_transfer',
      summary: `Sending ${amountStr} to ${recipientLabel}`,
    };
  } catch {
    return null;
  }
}

/**
 * Decode ERC-20 approve(address,uint256)
 * Selector: 0x095ea7b3
 */
export async function decodeErc20Approve(
  calldata: Hex,
  tokenAddress: Address,
  chainId: number,
): Promise<Erc20DecodeResult | null> {
  if (calldata.length < 138) return null;

  const selector = calldata.slice(0, 10).toLowerCase();
  if (selector !== ERC20_SELECTORS.approve) return null;

  try {
    const data = calldata.slice(10);
    const spenderPadded = data.slice(0, 64);
    const amountHex = data.slice(64, 128);

    const spender = `0x${spenderPadded.slice(24)}` as Address;
    const amount = BigInt(`0x${amountHex}`);

    const isUnlimited = amount === BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

    const tokenInfo = await fetchTokenInfo(tokenAddress, chainId);

    let amountStr: string;
    const warnings: string[] = [];

    if (isUnlimited) {
      amountStr = 'unlimited';
      warnings.push('⚠️ This is an unlimited approval — the spender can move all tokens');
    } else if (tokenInfo) {
      amountStr = formatTokenAmount(amount, tokenInfo.decimals, tokenInfo.symbol);
    } else {
      amountStr = `${amount.toString()} (raw units) of ${shortenAddress(tokenAddress)}`;
    }

    const tokenLabel = tokenInfo ? tokenInfo.symbol : await labelAddress(tokenAddress, chainId, false);
    const spenderLabel = await labelAddress(spender, chainId);

    return {
      type: 'erc20_approve',
      summary: `Granting approval for ${amountStr} ${tokenLabel} to ${spenderLabel}`,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Decode ERC-20 transferFrom(address,address,uint256)
 * Selector: 0x23b872dd
 */
export async function decodeErc20TransferFrom(
  calldata: Hex,
  tokenAddress: Address,
  chainId: number,
): Promise<Erc20DecodeResult | null> {
  if (calldata.length < 202) return null; // 4 + 32 + 32 + 32 bytes

  const selector = calldata.slice(0, 10).toLowerCase();
  if (selector !== ERC20_SELECTORS.transferFrom) return null;

  try {
    const data = calldata.slice(10);
    const fromPadded = data.slice(0, 64);
    const toPadded = data.slice(64, 128);
    const amountHex = data.slice(128, 192);

    const from = `0x${fromPadded.slice(24)}` as Address;
    const to = `0x${toPadded.slice(24)}` as Address;
    const amount = BigInt(`0x${amountHex}`);

    const tokenInfo = await fetchTokenInfo(tokenAddress, chainId);

    let amountStr: string;
    if (tokenInfo) {
      amountStr = formatTokenAmount(amount, tokenInfo.decimals, tokenInfo.symbol);
    } else {
      amountStr = `${amount.toString()} (raw units) of ${shortenAddress(tokenAddress)}`;
    }

    const fromLabel = await labelAddress(from, chainId);
    const toLabel = await labelAddress(to, chainId);
    return {
      type: 'erc20_transfer',
      summary: `Transferring ${amountStr} from ${fromLabel} to ${toLabel}`,
    };
  } catch {
    return null;
  }
}
