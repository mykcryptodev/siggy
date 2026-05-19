import { getChain, getSafeAppUrl, getExplorerTxUrl } from '../chains.js';
import type { safeTransactions } from '../db/schema.js';
import type { NotificationType, DecodedSummaryJson } from '../db/schema.js';
import { labelAddress, shortenAddress } from '../decoder/labels.js';
import { formatEther } from 'viem';

type SafeTx = typeof safeTransactions.$inferSelect;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatValue(valueWei: string | null, nativeCurrency: string): string {
  if (!valueWei || valueWei === '0') return `0 ${nativeCurrency}`;
  try {
    const eth = formatEther(BigInt(valueWei));
    const num = parseFloat(eth);
    const display = num.toFixed(6).replace(/\.?0+$/, '');
    return `${display} ${nativeCurrency}`;
  } catch {
    return `? ${nativeCurrency}`;
  }
}

function getSafeLabel(safeAddress: string, label: string | null): string {
  if (label) return escapeHtml(label);
  return shortenAddress(safeAddress);
}

function getSummary(decoded: DecodedSummaryJson | null, tx: SafeTx): string {
  if (decoded?.summary) return escapeHtml(decoded.summary);
  if (tx.toAddress) return `Contract interaction with ${shortenAddress(tx.toAddress)}`;
  return 'Unknown action';
}

function getWarnings(decoded: DecodedSummaryJson | null): string {
  if (!decoded?.warnings?.length) return '';
  return '\n' + decoded.warnings.map((w) => escapeHtml(w)).join('\n');
}

/**
 * Format a "New pending transaction" notification message (HTML)
 */
export function formatPendingMessage(params: {
  tx: SafeTx;
  safeAddress: string;
  chainId: number;
  label: string | null;
}): string {
  const { tx, safeAddress, chainId, label } = params;
  const chain = getChain(chainId);
  const decoded = tx.decodedSummary as DecodedSummaryJson | null;

  const safeLabel = getSafeLabel(safeAddress, label);
  const summary = getSummary(decoded, tx);
  const warnings = getWarnings(decoded);
  const value = formatValue(tx.valueWei, chain.nativeCurrency);
  const safeUrl = getSafeAppUrl(safeAddress, chainId);
  const sigs = `${tx.confirmationCount}/${tx.requiredConfirmations ?? '?'}`;

  return (
    `🔔 <b>New transaction proposed</b>\n` +
    `<i>Safe: ${safeLabel} (${escapeHtml(chain.name)})</i>\n\n` +
    `📤 ${summary}${warnings}\n` +
    `💰 Value: ${escapeHtml(value)}\n` +
    `🔢 Nonce: #${tx.nonce ?? '?'}  ✅ Signatures: ${sigs}\n\n` +
    `<a href="${safeUrl}">View on Safe ↗</a>`
  );
}

/**
 * Format a "Transaction executed" notification message (HTML)
 */
export function formatExecutedMessage(params: {
  tx: SafeTx;
  safeAddress: string;
  chainId: number;
  label: string | null;
}): string {
  const { tx, safeAddress, chainId, label } = params;
  const chain = getChain(chainId);
  const decoded = tx.decodedSummary as DecodedSummaryJson | null;

  const safeLabel = getSafeLabel(safeAddress, label);
  const summary = getSummary(decoded, tx);

  let explorerLine = '';
  if (tx.onChainHash) {
    const explorerUrl = getExplorerTxUrl(tx.onChainHash, chainId);
    explorerLine = `\n<a href="${explorerUrl}">View on Explorer ↗</a>`;
  } else {
    const safeUrl = getSafeAppUrl(safeAddress, chainId);
    explorerLine = `\n<a href="${safeUrl}">View on Safe ↗</a>`;
  }

  return (
    `✅ <b>Transaction executed</b>\n` +
    `<i>Safe: ${safeLabel} (${escapeHtml(chain.name)})</i>\n\n` +
    `📤 ${summary}\n` +
    `🔢 Nonce: #${tx.nonce ?? '?'}` +
    explorerLine
  );
}

/**
 * Format a "Transaction cancelled" notification message (HTML)
 */
export function formatCancelledMessage(params: {
  tx: SafeTx;
  safeAddress: string;
  chainId: number;
  label: string | null;
}): string {
  const { tx, safeAddress, chainId, label } = params;
  const chain = getChain(chainId);
  const decoded = tx.decodedSummary as DecodedSummaryJson | null;

  const safeLabel = getSafeLabel(safeAddress, label);
  const summary = getSummary(decoded, tx);

  return (
    `❌ <b>Transaction cancelled</b>\n` +
    `<i>Safe: ${safeLabel} (${escapeHtml(chain.name)})</i>\n\n` +
    `📤 Was: ${summary}\n` +
    `🔢 Nonce: #${tx.nonce ?? '?'}`
  );
}

/**
 * Get the appropriate message for a notification type
 */
export function formatNotificationMessage(params: {
  tx: SafeTx;
  safeAddress: string;
  chainId: number;
  label: string | null;
  notificationType: NotificationType;
}): string {
  switch (params.notificationType) {
    case 'pending':
      return formatPendingMessage(params);
    case 'executed':
      return formatExecutedMessage(params);
    case 'cancelled':
      return formatCancelledMessage(params);
  }
}
