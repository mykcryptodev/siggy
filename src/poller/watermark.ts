import {
  fetchAllTxHashesForWatermark,
  fetchMultisigTransactions,
  SafeFetchError,
} from './fetcher.js';
import {
  bulkInsertWatermarkedTxHashes,
  getExistingTxHashesForSafe,
} from '../db/queries.js';

/**
 * Watermark a newly added Safe.
 *
 * Fetches all current transaction hashes from the Safe Transaction Service
 * and inserts them as 'watermarked' status in the DB so we don't spam the
 * chat with historical transactions when a Safe is first added.
 *
 * Returns the number of hashes watermarked.
 */
export async function watermarkSafe(safeAddress: string, chainId: number): Promise<number> {
  // Fetch all existing tx hashes from STS
  let allHashes: string[];
  try {
    allHashes = await fetchAllTxHashesForWatermark(safeAddress, chainId);
  } catch (err) {
    if (err instanceof SafeFetchError && !err.retryable) {
      throw err;
    }
    // For transient errors, try fetching just the recent ones
    try {
      const recentTxs = await fetchMultisigTransactions(safeAddress, chainId, 100);
      allHashes = recentTxs.map((tx) => tx.safeTxHash);
    } catch {
      allHashes = [];
    }
  }

  if (allHashes.length === 0) {
    return 0;
  }

  // Only insert hashes we don't already have in DB
  const existingHashes = await getExistingTxHashesForSafe(safeAddress, chainId);
  const existingSet = new Set(existingHashes);
  const newHashes = allHashes.filter((h) => !existingSet.has(h));

  if (newHashes.length > 0) {
    await bulkInsertWatermarkedTxHashes(safeAddress, chainId, newHashes);
  }

  return newHashes.length;
}
