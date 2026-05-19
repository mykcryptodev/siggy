import { getChain, getSafeAppUrl, getExplorerTxUrl } from '../chains.js';
import type { safeTransactions } from '../db/schema.js';
import type { NotificationType, DecodedSummaryJson } from '../db/schema.js';
import { labelAddress, labelAddresses, shortenAddress } from '../decoder/labels.js';
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

async function getSafeLabel(safeAddress: string, label: string | null, chainId: number): Promise<string> {
  if (label) return escapeHtml(label);
  // Try to resolve via known labels / ENS / Basenames
  const resolved = await labelAddress(safeAddress, chainId);
  return escapeHtml(resolved);
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

// Extract signer addresses from raw STS payload
function getSignerAddresses(rawPayload: unknown): string[] {
  if (!rawPayload || typeof rawPayload !== 'object') return [];
  const payload = rawPayload as Record<string, unknown>;
  const confirmations = payload.confirmations;
  if (!Array.isArray(confirmations)) return [];
  return confirmations
    .map((c: unknown) => {
      if (typeof c === 'object' && c !== null && 'owner' in c) {
        return (c as Record<string, unknown>).owner as string;
      }
      return null;
    })
    .filter(Boolean) as string[];
}

async function buildSignerLine(
  tx: SafeTx,
  chainId: number,
): Promise<string> {
  const count = tx.confirmationCount ?? 0;
  const required = tx.requiredConfirmations ?? '?';
  const signers = getSignerAddresses(tx.rawPayload);

  if (signers.length === 0) {
    return `✅ Signatures: ${count}/${required}`;
  }

  const labels = await labelAddresses(signers, chainId);
  const signerNames = signers.map((s) => escapeHtml(labels[s] ?? shortenAddress(s))).join(', ');

  const remaining = (typeof required === 'number') ? Math.max(0, required - count) : '?';
  let line = `✅ Signed (${count}/${required}): ${signerNames}`;
  if (remaining !== '?' && remaining > 0) {
    line += `\n⏳ Still needs ${remaining} more signature${remaining === 1 ? '' : 's'}`;
  } else if (remaining === 0) {
    line += `\n🚀 Ready to execute!`;
  }
  return line;
}

/**
 * Format a "New pending transaction" notification message (HTML)
 */
export async function formatPendingMessage(params: {
  tx: SafeTx;
  safeAddress: string;
  chainId: number;
  label: string | null;
}): Promise<string> {
  const { tx, safeAddress, chainId, label } = params;
  const chain = getChain(chainId);
  const decoded = tx.decodedSummary as DecodedSummaryJson | null;

  const safeLabel = await getSafeLabel(safeAddress, label, chainId);
  const summary = getSummary(decoded, tx);
  const warnings = getWarnings(decoded);
  const value = formatValue(tx.valueWei, chain.nativeCurrency);
  const safeUrl = getSafeAppUrl(safeAddress, chainId);
  const signerLine = await buildSignerLine(tx, chainId);

  return (
    `🔔 <b>New transaction proposed</b>\n` +
    `<i>Safe: ${safeLabel} (${escapeHtml(chain.name)})</i>\n\n` +
    `📤 ${summary}${warnings}\n` +
    `💰 Value: ${escapeHtml(value)}\n` +
    `🔢 Nonce: #${tx.nonce ?? '?'}\n` +
    `${signerLine}\n\n` +
    `<a href="${safeUrl}">View on Safe ↗</a>`
  );
}

/**
 * Format a "Transaction executed" notification message (HTML)
 */
export async function formatExecutedMessage(params: {
  tx: SafeTx;
  safeAddress: string;
  chainId: number;
  label: string | null;
}): Promise<string> {
  const { tx, safeAddress, chainId, label } = params;
  const chain = getChain(chainId);
  const decoded = tx.decodedSummary as DecodedSummaryJson | null;

  const safeLabel = await getSafeLabel(safeAddress, label, chainId);
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
export async function formatCancelledMessage(params: {
  tx: SafeTx;
  safeAddress: string;
  chainId: number;
  label: string | null;
}): Promise<string> {
  const { tx, safeAddress, chainId, label } = params;
  const chain = getChain(chainId);
  const decoded = tx.decodedSummary as DecodedSummaryJson | null;

  const safeLabel = await getSafeLabel(safeAddress, label, chainId);
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
export async function formatNotificationMessage(params: {
  tx: SafeTx;
  safeAddress: string;
  chainId: number;
  label: string | null;
  notificationType: NotificationType;
}): Promise<string> {
  switch (params.notificationType) {
    case 'pending':
      return formatPendingMessage(params);
    case 'executed':
      return formatExecutedMessage(params);
    case 'cancelled':
      return formatCancelledMessage(params);
  }
}
