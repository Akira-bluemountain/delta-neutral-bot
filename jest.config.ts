import type { Config } from "jest";

/**
 * Jest 設定（ts-jest 経由で TypeScript テスト実行）
 * Phase A Task A1 で追加。
 */
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  roots: ["<rootDir>/tests"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.test.json",
        // diagnostics を有効化して型ミスを即座にキャッチ
        diagnostics: true,
      },
    ],
  },
  // 各テストの最大実行時間 10 秒（ポーリング系のテストがあるため少し長め）
  testTimeout: 10_000,
  // テスト終了後のハンドル未解放を検知
  detectOpenHandles: true,
  // テスト実行前に必須環境変数のダミー値を注入
  setupFiles: ["<rootDir>/tests/setup-env.ts"],
};

export default config;
