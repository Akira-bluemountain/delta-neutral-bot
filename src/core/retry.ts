// エラーメッセージから秘密情報を除去（APIキー・署名等がレスポンスに含まれる場合の安全策）
function sanitizeErrorMessage(msg: string): string {
  // Bearer トークン、0x で始まる長いhex文字��、APIキーパターンを除去
  return msg
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/0x[0-9a-fA-F]{40,}/g, "0x[REDACTED]")
    .replace(/"(r|s)"\s*:\s*"0x[0-9a-fA-F]+"/g, '"$1":"[REDACTED]"');
}

// 指数バックオフ付きリトライ（最大3回）
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries: number = 3
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
        console.warn(
          `[リトライ] ${label} 失敗 (${attempt}/${maxRetries}): ${sanitizeErrorMessage(lastError.message)} → ${delay}ms後に再試行`
        );
        await sleep(delay);
      }
    }
  }
  throw new Error(
    `[リトライ上限] ${label}: ${maxRetries}回失敗 → ${sanitizeErrorMessage(lastError?.message ?? "不明")}`
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
