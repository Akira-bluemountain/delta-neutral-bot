/**
 * テスト基盤のスモークテスト。
 * Jest + ts-jest が正しく動作しているかを確認する最小テスト。
 */
describe("test infrastructure smoke test", () => {
  it("Jest が TypeScript を実行できる", () => {
    const value: number = 1 + 1;
    expect(value).toBe(2);
  });

  it("非同期テストが動作する", async () => {
    const result = await Promise.resolve("ok");
    expect(result).toBe("ok");
  });
});
