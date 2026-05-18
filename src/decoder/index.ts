import { formatEther, type Hex, type Address } from 'viem';
import {
  ERC20_SELECTORS,
  decodeErc20Transfer,
  decodeErc20Approve,
  decodeErc20TransferFrom,
} from './erc20.js';
import { describeFunctionCall } from './fourbyte.js';
import type { DecodedSummaryJson, TxType } from '../db/schema.js';

export interface RawTransactionData {
  to: string | null;
  value: string; // wei as string
  data: string | null; // calldata hex or null
  chainId: number;
}

function shortenAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function getSelector(calldata: string): string {
  return calldata.slice(0, 10).toLowerCase();
}

/**
 * Main decoder entry point.
 * Tries each layer in sequence and returns the best result.
 */
export async function decodeTx(tx: RawTransactionData): Promise<DecodedSummaryJson> {
  const calldata = tx.data ?? '0x';
  const value = BigInt(tx.value ?? '0');
  const to = tx.to ?? '';

  // ──────────────────────────────────────────────
  // Layer 1: Native ETH transfer
  // ──────────────────────────────────────────────
  if ((calldata === '0x' || calldata === '') && value > 0n) {
    const ethAmount = formatEther(value);
    const displayEth = parseFloat(ethAmount).toFixed(6).replace(/\.?0+$/, '');
    return {
      type: 'eth_transfer' as TxType,
      summary: `Sending ${displayEth} ETH to ${shortenAddress(to)}`,
      confidence: 'high',
    };
  }

  // Need at least a selector for further decoding
  if (calldata.length < 10) {
    return buildFallback(to, value, calldata);
  }

  const selector = getSelector(calldata);

  // ──────────────────────────────────────────────
  // Layer 2: ERC-20 hardcoded selectors
  // ──────────────────────────────────────────────
  if (selector === ERC20_SELECTORS.transfer) {
    const result = await decodeErc20Transfer(calldata as Hex, to as Address, tx.chainId);
    if (result) {
      return {
        type: result.type,
        summary: result.summary,
        confidence: 'high',
        warnings: result.warnings,
      };
    }
  }

  if (selector === ERC20_SELECTORS.approve) {
    const result = await decodeErc20Approve(calldata as Hex, to as Address, tx.chainId);
    if (result) {
      return {
        type: result.type,
        summary: result.summary,
        confidence: 'high',
        warnings: result.warnings,
      };
    }
  }

  if (selector === ERC20_SELECTORS.transferFrom) {
    const result = await decodeErc20TransferFrom(calldata as Hex, to as Address, tx.chainId);
    if (result) {
      return {
        type: result.type,
        summary: result.summary,
        confidence: 'high',
      };
    }
  }

  // ──────────────────────────────────────────────
  // Layer 3: 4byte.directory lookup
  // ──────────────────────────────────────────────
  const funcDesc = await describeFunctionCall(selector, to);
  if (!funcDesc.includes('unknown function')) {
    return {
      type: 'contract_call',
      summary: funcDesc,
      confidence: 'medium',
    };
  }

  // ──────────────────────────────────────────────
  // Layer 4 (fallback): Unknown interaction
  // ──────────────────────────────────────────────
  return buildFallback(to, value, calldata, funcDesc);
}

function buildFallback(
  to: string,
  value: bigint,
  calldata: string,
  hint?: string,
): DecodedSummaryJson {
  const parts: string[] = [];

  if (hint) {
    parts.push(hint);
  } else {
    parts.push(`A complex contract interaction (could not fully decode)`);
  }

  if (value > 0n) {
    const ethAmount = formatEther(value);
    const displayEth = parseFloat(ethAmount).toFixed(6).replace(/\.?0+$/, '');
    parts.push(`Value: ${displayEth} ETH`);
  }

  return {
    type: 'unknown',
    summary: parts[0] ?? `A complex contract interaction (could not fully decode)`,
    details: parts.length > 1 ? parts.slice(1) : undefined,
    confidence: 'low',
  };
}
