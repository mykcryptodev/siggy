import { getChain } from '../chains.js';
import { z } from 'zod';

// ──────────────────────────────────────────────
// Zod schemas for Safe Transaction Service responses
// ──────────────────────────────────────────────

const ConfirmationSchema = z.object({
  owner: z.string(),
  submissionDate: z.string(),
  transactionHash: z.string().nullable(),
  signature: z.string(),
  signatureType: z.string(),
});

export const SafeMultisigTransactionSchema = z.object({
  safe: z.string(),
  to: z.string(),
  value: z.string(),
  data: z.string().nullable(),
  operation: z.number(),
  gasToken: z.string(),
  safeTxGas: z.number(),
  baseGas: z.number(),
  gasPrice: z.string(),
  refundReceiver: z.string(),
  nonce: z.number(),
  executionDate: z.string().nullable(),
  submissionDate: z.string(),
  modified: z.string(),
  blockNumber: z.number().nullable(),
  transactionHash: z.string().nullable(),
  safeTxHash: z.string(),
  executor: z.string().nullable(),
  isExecuted: z.boolean(),
  isSuccessful: z.boolean().nullable(),
  ethGasPrice: z.string().nullable(),
  maxFeePerGas: z.string().nullable(),
  maxPriorityFeePerGas: z.string().nullable(),
  gasUsed: z.number().nullable(),
  fee: z.string().nullable(),
  origin: z.string().nullable(),
  dataDecoded: z.unknown().nullable(),
  confirmationsRequired: z.number(),
  confirmations: z.array(ConfirmationSchema).nullable(),
  trusted: z.boolean(),
  signatures: z.string().nullable(),
});

export type SafeMultisigTransaction = z.infer<typeof SafeMultisigTransactionSchema>;

const SafeMultisigTransactionsResponseSchema = z.object({
  count: z.number(),
  next: z.string().nullable(),
  previous: z.string().nullable(),
  results: z.array(SafeMultisigTransactionSchema),
});

// ──────────────────────────────────────────────
// Fetcher
// ──────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 20;

export class SafeFetchError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

/**
 * Fetch recent multisig transactions for a Safe address.
 * Returns the most recent `limit` transactions ordered by nonce descending.
 */
export async function fetchMultisigTransactions(
  safeAddress: string,
  chainId: number,
  limit: number = DEFAULT_LIMIT,
): Promise<SafeMultisigTransaction[]> {
  const chain = getChain(chainId);
  const url = `${chain.stsBaseUrl}/api/v1/safes/${safeAddress}/multisig-transactions/?ordering=-nonce&limit=${limit}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    throw new SafeFetchError(`Failed to fetch Safe transactions: ${message}`, undefined, true);
  }

  if (response.status === 404) {
    throw new SafeFetchError(
      `Safe not found: ${safeAddress} on chain ${chainId}`,
      404,
      false, // not retryable — Safe doesn't exist on this chain
    );
  }

  if (response.status === 429) {
    throw new SafeFetchError(
      `Rate limited by Safe Transaction Service for ${safeAddress}`,
      429,
      true,
    );
  }

  if (!response.ok) {
    throw new SafeFetchError(
      `Safe Transaction Service returned ${response.status} for ${safeAddress}`,
      response.status,
      response.status >= 500, // server errors are retryable
    );
  }

  let rawData: unknown;
  try {
    rawData = await response.json();
  } catch {
    throw new SafeFetchError('Failed to parse Safe Transaction Service response as JSON', undefined, true);
  }

  const parsed = SafeMultisigTransactionsResponseSchema.safeParse(rawData);
  if (!parsed.success) {
    console.error('[fetcher] STS response schema validation failed:', parsed.error.issues);
    // Return empty rather than crashing — schema drift shouldn't break the bot
    return [];
  }

  return parsed.data.results;
}

/**
 * Fetch ALL transaction hashes for a Safe (for watermarking).
 * Paginates through all pages to get complete history.
 * Capped at 500 to prevent runaway pagination.
 */
export async function fetchAllTxHashesForWatermark(
  safeAddress: string,
  chainId: number,
): Promise<string[]> {
  const chain = getChain(chainId);
  const allHashes: string[] = [];
  const MAX_WATERMARK_TXS = 500;
  let url: string | null =
    `${chain.stsBaseUrl}/api/v1/safes/${safeAddress}/multisig-transactions/?limit=100&ordering=-nonce`;

  while (url && allHashes.length < MAX_WATERMARK_TXS) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      break; // stop pagination on network error
    }

    if (!response.ok) break;

    let rawData: unknown;
    try {
      rawData = await response.json();
    } catch {
      break;
    }

    const parsed = SafeMultisigTransactionsResponseSchema.safeParse(rawData);
    if (!parsed.success) break;

    for (const tx of parsed.data.results) {
      allHashes.push(tx.safeTxHash);
    }

    url = parsed.data.next;
  }

  return allHashes;
}

/**
 * Determine the effective status of a transaction from STS data.
 */
export function getTxStatus(tx: SafeMultisigTransaction): 'pending' | 'executed' | 'cancelled' {
  if (tx.isExecuted && tx.isSuccessful === true) return 'executed';
  if (tx.isExecuted && tx.isSuccessful === false) return 'cancelled';
  return 'pending';
}
