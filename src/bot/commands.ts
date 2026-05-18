import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import {
  getCommunityByChatId,
  upsertCommunity,
  addMonitoredSafe,
  removeMonitoredSafe,
  getMonitoredSafesForCommunity,
  countMonitoredSafes,
  countActiveCommunities,
} from '../db/queries.js';
import { watermarkSafe } from '../poller/watermark.js';
import { requireAdmin, ensureCommunity } from './middleware.js';
import { CHAINS, SUPPORTED_CHAIN_IDS, getChain } from '../chains.js';
import { isAddress, getAddress } from 'viem';

// ──────────────────────────────────────────────
// Helper: resolve or create community from context
// ���─────────────────────────────────────────────

async function getOrCreateCommunity(ctx: Context) {
  if (!ctx.chat) return null;

  let community = await getCommunityByChatId(BigInt(ctx.chat.id));
  if (!community) {
    const chatTitle =
      'title' in ctx.chat ? ctx.chat.title : ('username' in ctx.chat ? ctx.chat.username : null);
    community = await upsertCommunity({
      telegramChatId: BigInt(ctx.chat.id),
      chatType: ctx.chat.type,
      chatTitle: chatTitle ?? null,
      adminUserIds: ctx.from ? [ctx.from.id.toString()] : [],
    });
  }
  return community;
}

function isValidEthAddress(addr: string): boolean {
  return isAddress(addr);
}

function checksumAddress(addr: string): string {
  try {
    return getAddress(addr);
  } catch {
    return addr;
  }
}

// ──────────────────────────────────────────────
// /start
// ──────────────────────────────────────────────

export function registerStart(bot: Bot<Context>): void {
  bot.command('start', async (ctx) => {
    await ctx.reply(
      `👋 <b>Hey! I'm Siggy, your Safe multisig transparency bot.</b>\n\n` +
      `I watch Gnosis Safe wallets and post human-readable notifications whenever a transaction is proposed, executed, or cancelled.\n\n` +
      `<b>Getting started:</b>\n` +
      `1. Add me to your group\n` +
      `2. Run <code>/addsafe 0xYOUR_SAFE_ADDRESS</code>\n` +
      `3. I'll start watching!\n\n` +
      `Run <code>/help</code> to see all commands.`,
      { parse_mode: 'HTML' },
    );
  });
}

// ──────────────────────────────────────────────
// /help
// ──────────────────────────────────────────────

export function registerHelp(bot: Bot<Context>): void {
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `<b>Siggy — Safe Transparency Bot</b>\n\n` +
      `<b>Commands:</b>\n` +
      `• <code>/addsafe &lt;address&gt; [chain] [label]</code> — Monitor a Safe\n` +
      `• <code>/listsafes</code> — Show all monitored Safes in this chat\n` +
      `• <code>/removesafe &lt;address&gt;</code> — Stop monitoring a Safe\n` +
      `• <code>/status</code> — Bot status and stats\n` +
      `• <code>/help</code> — This message\n\n` +
      `<b>Examples:</b>\n` +
      `<code>/addsafe 0x1234...abcd</code>\n` +
      `<code>/addsafe 0x1234...abcd base Treasury</code>\n\n` +
      `<b>Supported chains:</b>\n` +
      SUPPORTED_CHAIN_IDS.map((id) => `• ${CHAINS[id]!.name} (chain ID: ${id})`).join('\n'),
      { parse_mode: 'HTML' },
    );
  });
}

// ──────────────────────────────────────────────
// /addsafe
// ──────────────────────────────────────────────

export function registerAddSafe(bot: Bot<Context>): void {
  // Main command
  bot.command('addsafe', ensureCommunity, requireAdmin, async (ctx) => {
    const args = ctx.match?.trim().split(/\s+/) ?? [];

    if (args.length === 0 || !args[0]) {
      await ctx.reply(
        '❌ Usage: <code>/addsafe &lt;address&gt; [chain] [label]</code>\n\n' +
        'Example: <code>/addsafe 0x1234...abcd base Treasury</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const safeAddress = args[0];
    if (!isValidEthAddress(safeAddress)) {
      await ctx.reply('❌ Invalid Ethereum address. Please provide a valid Safe address.');
      return;
    }

    const checksummed = checksumAddress(safeAddress);

    // Parse optional chain arg
    let chainId: number | null = null;
    let labelParts: string[] = [];

    if (args[1]) {
      // Check if second arg is a chain name or ID
      const chainArg = args[1].toLowerCase();
      const matchedChain = SUPPORTED_CHAIN_IDS.find(
        (id) =>
          CHAINS[id]!.shortName.toLowerCase() === chainArg ||
          CHAINS[id]!.name.toLowerCase() === chainArg ||
          id.toString() === chainArg,
      );

      if (matchedChain) {
        chainId = matchedChain;
        labelParts = args.slice(2);
      } else {
        // Assume all remaining args are the label
        labelParts = args.slice(1);
      }
    }

    const label = labelParts.length > 0 ? labelParts.join(' ') : null;

    if (chainId !== null) {
      // Chain specified — add directly
      await doAddSafe(ctx, checksummed, chainId, label);
    } else {
      // No chain specified — show inline keyboard
      const keyboard = new InlineKeyboard();
      const chainEntries = SUPPORTED_CHAIN_IDS.map((id) => ({
        id,
        name: CHAINS[id]!.name,
      }));

      // Two chains per row
      for (let i = 0; i < chainEntries.length; i += 2) {
        const a = chainEntries[i]!;
        const b = chainEntries[i + 1];
        const labelStr = label ? `:${encodeURIComponent(label)}` : '';
        keyboard.text(a.name, `chain_select:${checksummed}:${a.id}${labelStr}`);
        if (b) {
          keyboard.text(b.name, `chain_select:${checksummed}:${b.id}${labelStr}`);
        }
        keyboard.row();
      }

      await ctx.reply(
        `Which chain is <code>${checksummed}</code> on?`,
        { parse_mode: 'HTML', reply_markup: keyboard },
      );
    }
  });

  // Handle chain selection callback
  bot.callbackQuery(/^chain_select:/, ensureCommunity, requireAdmin, async (ctx) => {
    await ctx.answerCallbackQuery();

    const data = ctx.callbackQuery.data;
    // Format: chain_select:<address>:<chainId>[:encoded_label]
    const parts = data.slice('chain_select:'.length).split(':');
    if (parts.length < 2) return;

    const safeAddress = parts[0]!;
    const chainId = parseInt(parts[1]!, 10);
    const label = parts[2] ? decodeURIComponent(parts[2]) : null;

    if (!CHAINS[chainId]) {
      await ctx.editMessageText('❌ Unsupported chain selected.');
      return;
    }

    if (!isValidEthAddress(safeAddress)) {
      await ctx.editMessageText('❌ Invalid Safe address.');
      return;
    }

    await ctx.deleteMessage().catch(() => null);
    await doAddSafe(ctx, safeAddress, chainId, label);
  });
}

async function doAddSafe(
  ctx: Context,
  safeAddress: string,
  chainId: number,
  label: string | null,
): Promise<void> {
  const community = await getOrCreateCommunity(ctx);
  if (!community) {
    await ctx.reply('❌ Internal error: could not identify this chat.');
    return;
  }

  const chain = getChain(chainId);
  const safeLabel = label ? ` (${label})` : '';

  const statusMsg = await ctx.reply(
    `⏳ Adding <code>${safeAddress}</code> on ${chain.name}${safeLabel}...\nFetching transaction history to set watermark...`,
    { parse_mode: 'HTML' },
  );

  try {
    // Add to DB
    await addMonitoredSafe({
      communityId: community.id,
      safeAddress,
      chainId,
      label,
      addedBy: ctx.from ? BigInt(ctx.from.id) : BigInt(0),
    });

    // Watermark: record all existing tx hashes so we don't send historical notifications
    let watermarkedCount = 0;
    try {
      watermarkedCount = await watermarkSafe(safeAddress, chainId);
    } catch (err) {
      console.error('[commands] Watermark failed:', err);
      // Non-fatal — continue without watermark
    }

    const watermarkNote =
      watermarkedCount > 0
        ? `\nWatermarked ${watermarkedCount} existing transaction(s) — no historical spam.`
        : '\nNo existing transactions found.';

    await ctx.api.editMessageText(
      community.telegramChatId.toString(),
      statusMsg.message_id,
      `✅ <b>Now monitoring Safe</b>: <code>${safeAddress}</code>${safeLabel}\n` +
      `<b>Chain:</b> ${chain.name}\n${watermarkNote}\n\n` +
      `I'll notify this chat for every new, executed, or cancelled transaction.`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    // Check for unique constraint violation
    if (errMsg.includes('unique') || errMsg.includes('duplicate')) {
      await ctx.api.editMessageText(
        community.telegramChatId.toString(),
        statusMsg.message_id,
        `ℹ️ <code>${safeAddress}</code> on ${chain.name} is already being monitored in this chat.`,
        { parse_mode: 'HTML' },
      );
      return;
    }
    await ctx.api.editMessageText(
      community.telegramChatId.toString(),
      statusMsg.message_id,
      `❌ Failed to add Safe: ${errMsg}`,
      { parse_mode: 'HTML' },
    );
  }
}

// ──────────────────────────────────────────────
// /listsafes
// ──────────────────────────────────────────────

export function registerListSafes(bot: Bot<Context>): void {
  bot.command('listsafes', ensureCommunity, async (ctx) => {
    const community = await getOrCreateCommunity(ctx);
    if (!community) {
      await ctx.reply('❌ Internal error.');
      return;
    }

    const safes = await getMonitoredSafesForCommunity(community.id);

    if (safes.length === 0) {
      await ctx.reply(
        '📭 No Safes are being monitored in this chat.\n\nUse <code>/addsafe &lt;address&gt;</code> to add one.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const lines = safes.map((s) => {
      const chain = CHAINS[s.chainId];
      const chainName = chain?.name ?? `Chain ${s.chainId}`;
      const label = s.label ? ` — ${s.label}` : '';
      return `• <code>${s.safeAddress}</code> (${chainName})${label}`;
    });

    await ctx.reply(
      `<b>Monitored Safes (${safes.length})</b>\n\n${lines.join('\n')}`,
      { parse_mode: 'HTML' },
    );
  });
}

// ──────────────────────────────────────────────
// /removesafe
// ──────────────────────────────────────────────

export function registerRemoveSafe(bot: Bot<Context>): void {
  bot.command('removesafe', ensureCommunity, requireAdmin, async (ctx) => {
    const args = ctx.match?.trim().split(/\s+/) ?? [];

    if (!args[0]) {
      await ctx.reply(
        '❌ Usage: <code>/removesafe &lt;address&gt;</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const safeAddress = args[0];
    if (!isValidEthAddress(safeAddress)) {
      await ctx.reply('❌ Invalid Ethereum address.');
      return;
    }

    const checksummed = checksumAddress(safeAddress);
    const community = await getOrCreateCommunity(ctx);
    if (!community) {
      await ctx.reply('❌ Internal error.');
      return;
    }

    // Check how many entries exist for this address (might be multiple chains)
    const safes = await getMonitoredSafesForCommunity(community.id);
    const matching = safes.filter(
      (s) => s.safeAddress.toLowerCase() === checksummed.toLowerCase(),
    );

    if (matching.length === 0) {
      await ctx.reply(`ℹ️ <code>${checksummed}</code> is not being monitored in this chat.`, {
        parse_mode: 'HTML',
      });
      return;
    }

    if (matching.length === 1) {
      // Only one chain — remove directly
      await removeMonitoredSafe({
        communityId: community.id,
        safeAddress: checksummed,
        chainId: matching[0]!.chainId,
      });
      const chain = CHAINS[matching[0]!.chainId];
      await ctx.reply(
        `✅ Removed <code>${checksummed}</code> (${chain?.name ?? 'unknown chain'}) from monitoring.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Multiple chains — show inline keyboard to pick which one
    const keyboard = new InlineKeyboard();
    for (const safe of matching) {
      const chain = CHAINS[safe.chainId];
      const label = chain?.name ?? `Chain ${safe.chainId}`;
      keyboard
        .text(label, `remove_confirm:${checksummed}:${safe.chainId}`)
        .row();
    }
    keyboard.text('Cancel', `remove_cancel`);

    await ctx.reply(
      `<code>${checksummed}</code> is monitored on multiple chains. Which one to remove?`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
  });

  bot.callbackQuery(/^remove_confirm:/, ensureCommunity, requireAdmin, async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data.slice('remove_confirm:'.length);
    const [safeAddress, chainIdStr] = data.split(':');
    const chainId = parseInt(chainIdStr ?? '', 10);

    const community = await getOrCreateCommunity(ctx);
    if (!community || !safeAddress) return;

    await removeMonitoredSafe({ communityId: community.id, safeAddress, chainId });
    const chain = CHAINS[chainId];

    await ctx.editMessageText(
      `✅ Removed <code>${safeAddress}</code> (${chain?.name ?? 'unknown chain'}) from monitoring.`,
      { parse_mode: 'HTML' },
    );
  });

  bot.callbackQuery('remove_cancel', async (ctx) => {
    await ctx.answerCallbackQuery('Cancelled');
    await ctx.deleteMessage().catch(() => null);
  });
}

// ──────────────────────────────────────────────
// /status
// ──────────────────────────────────────────────

export function registerStatus(bot: Bot<Context>): void {
  bot.command('status', async (ctx) => {
    const [totalSafes, totalCommunities] = await Promise.all([
      countMonitoredSafes(),
      countActiveCommunities(),
    ]);

    const community = await getOrCreateCommunity(ctx);
    const localSafes = community
      ? await getMonitoredSafesForCommunity(community.id)
      : [];

    await ctx.reply(
      `<b>🤖 Siggy Status</b>\n\n` +
      `🌐 Total monitored Safes: ${totalSafes}\n` +
      `👥 Active communities: ${totalCommunities}\n` +
      `📍 Safes in this chat: ${localSafes.length}\n\n` +
      `⏰ Last check: every 60 seconds (Vercel Cron)`,
      { parse_mode: 'HTML' },
    );
  });
}

// ──────────────────────────────────────────────
// Register all commands
// ──────────────────────────────────────────────

export function registerAllCommands(bot: Bot<Context>): void {
  registerStart(bot);
  registerHelp(bot);
  registerAddSafe(bot);
  registerListSafes(bot);
  registerRemoveSafe(bot);
  registerStatus(bot);
}
