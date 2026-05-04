const defaultImageExistsTimeoutMs = 8000;

type RemoteImageExistsOptions = {
  timeoutMs?: number;
};

function getTimeoutMs(timeoutMs: number | undefined) {
  return Number.isFinite(timeoutMs) && timeoutMs && timeoutMs > 0
    ? timeoutMs
    : defaultImageExistsTimeoutMs;
}

function createRequestInit(timeoutMs: number) {
  return {
    cache: "no-store" as const,
    signal: AbortSignal.timeout(timeoutMs),
  };
}

export async function remoteImageExists(
  url: string,
  options: RemoteImageExistsOptions = {}
) {
  const timeoutMs = getTimeoutMs(options.timeoutMs);

  try {
    const headResponse = await fetch(url, {
      method: "HEAD",
      ...createRequestInit(timeoutMs),
    });

    if (headResponse.ok) {
      return true;
    }

    if (headResponse.status !== 405) {
      return false;
    }
  } catch {
    // Continue with GET fallback below.
  }

  try {
    const getResponse = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      ...createRequestInit(timeoutMs),
    });
    return getResponse.ok;
  } catch {
    return false;
  }
}
