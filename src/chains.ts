export interface ChainConfig {
  chainId: number;
  name: string;
  shortName: string;
  stsBaseUrl: string;
  explorerBaseUrl: string;
  rpcUrl: string;
  nativeCurrency: string;
  safePrefix: string;
}

export const CHAINS: Record<number, ChainConfig> = {
  1: {
    chainId: 1,
    name: 'Ethereum',
    shortName: 'eth',
    stsBaseUrl: 'https://api.safe.global/tx-service/mainnet',
    explorerBaseUrl: 'https://etherscan.io',
    rpcUrl: 'https://cloudflare-eth.com',
    nativeCurrency: 'ETH',
    safePrefix: 'eth',
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    shortName: 'base',
    stsBaseUrl: 'https://api.safe.global/tx-service/base',
    explorerBaseUrl: 'https://basescan.org',
    rpcUrl: 'https://mainnet.base.org',
    nativeCurrency: 'ETH',
    safePrefix: 'base',
  },
  10: {
    chainId: 10,
    name: 'Optimism',
    shortName: 'oeth',
    stsBaseUrl: 'https://api.safe.global/tx-service/optimism',
    explorerBaseUrl: 'https://optimistic.etherscan.io',
    rpcUrl: 'https://mainnet.optimism.io',
    nativeCurrency: 'ETH',
    safePrefix: 'oeth',
  },
  42161: {
    chainId: 42161,
    name: 'Arbitrum',
    shortName: 'arb1',
    stsBaseUrl: 'https://api.safe.global/tx-service/arbitrum',
    explorerBaseUrl: 'https://arbiscan.io',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    nativeCurrency: 'ETH',
    safePrefix: 'arb1',
  },
  137: {
    chainId: 137,
    name: 'Polygon',
    shortName: 'matic',
    stsBaseUrl: 'https://api.safe.global/tx-service/polygon',
    explorerBaseUrl: 'https://polygonscan.com',
    rpcUrl: 'https://polygon-rpc.com',
    nativeCurrency: 'MATIC',
    safePrefix: 'matic',
  },
  100: {
    chainId: 100,
    name: 'Gnosis',
    shortName: 'gno',
    stsBaseUrl: 'https://api.safe.global/tx-service/gnosis-chain',
    explorerBaseUrl: 'https://gnosisscan.io',
    rpcUrl: 'https://rpc.gnosischain.com',
    nativeCurrency: 'xDAI',
    safePrefix: 'gno',
  },
};

export const SUPPORTED_CHAIN_IDS = Object.keys(CHAINS).map(Number);

export function getChain(chainId: number): ChainConfig {
  const chain = CHAINS[chainId];
  if (!chain) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
  return chain;
}

export function getSafeAppUrl(safeAddress: string, chainId: number): string {
  const chain = getChain(chainId);
  return `https://app.safe.global/transactions/queue?safe=${chain.safePrefix}:${safeAddress}`;
}

export function getExplorerTxUrl(txHash: string, chainId: number): string {
  const chain = getChain(chainId);
  return `${chain.explorerBaseUrl}/tx/${txHash}`;
}
