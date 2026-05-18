interface FourByteResult {
  id: number;
  created_at: string;
  text_signature: string;
  hex_signature: string;
  bytes_signature: string;
}

interface FourByteResponse {
  count: number;
  results: FourByteResult[];
}

// In-memory cache for 4byte lookups (selector → function name)
const selectorCache = new Map<string, string | null>();

/**
 * Look up a function selector on 4byte.directory
 * Returns the most likely function signature or null if not found
 */
export async function lookupSelector(selector: string): Promise<string | null> {
  const normalizedSelector = selector.toLowerCase();

  if (selectorCache.has(normalizedSelector)) {
    return selectorCache.get(normalizedSelector) ?? null;
  }

  try {
    const url = `https://www.4byte.directory/api/v1/signatures/?hex_signature=${normalizedSelector}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!response.ok) {
      selectorCache.set(normalizedSelector, null);
      return null;
    }

    const data = (await response.json()) as FourByteResponse;

    if (!data.results || data.results.length === 0) {
      selectorCache.set(normalizedSelector, null);
      return null;
    }

    // Pick the best candidate:
    // 1. Shortest name (less likely to be a collision)
    // 2. Created earliest (more established)
    const sorted = [...data.results].sort((a, b) => {
      const lenDiff = a.text_signature.length - b.text_signature.length;
      if (lenDiff !== 0) return lenDiff;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    const bestMatch = sorted[0].text_signature;
    // Extract just the function name (before the parenthesis)
    const funcName = bestMatch.split('(')[0] ?? bestMatch;

    selectorCache.set(normalizedSelector, funcName);
    return funcName;
  } catch {
    // Network error or timeout — don't cache, allow retry
    return null;
  }
}

/**
 * Format an unknown calldata with function name hint from 4byte
 */
export async function describeFunctionCall(
  selector: string,
  toAddress: string,
): Promise<string> {
  const funcName = await lookupSelector(selector);
  const shortTo = `${toAddress.slice(0, 6)}…${toAddress.slice(-4)}`;

  if (funcName) {
    return `Calling \`${funcName}\` on ${shortTo}`;
  }

  return `Calling unknown function (${selector}) on ${shortTo}`;
}
