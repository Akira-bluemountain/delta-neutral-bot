/**
 * Jest setup: 必須環境変数にテスト用のダミー値を注入する。
 * 実際の .env を用意しなくてもテストが走るようにするためのブートストラップ。
 * 実 HTTP / 実発注は test 内のモックで防ぐ前提。
 */
const defaults: Record<string, string> = {
  HL_API_WALLET_ADDRESS: "0x0000000000000000000000000000000000000000",
  HL_API_WALLET_PRIVATE_KEY:
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  EXTENDED_API_KEY: "test-api-key",
  EXTENDED_STARK_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
  EXTENDED_STARK_PUBLIC_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
  EXTENDED_VAULT_ID: "test-vault-id",
  DRY_RUN: "true",
  DB_PATH: ":memory:",
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
