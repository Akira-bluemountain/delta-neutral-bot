/**
 * Alo (POST_ONLY) 拒否率モニタリングのユニットテスト（Phase A Task A1）
 *
 * recordAloResult / getAloRejectionStats / monitorAloRejectionRate の
 * 内部状態管理（FIFO 窓、閾値判定、クールダウン）を検証する。
 *
 * テストごとに monitor モジュールを再読み込みして状態をリセット。
 */

describe("Alo rejection rate monitor (Phase A Task A1)", () => {
  afterEach(() => {
    // テスト終了時にすべてのモック・スパイを復元（次テストの spy 汚染を防止）
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    // モジュールキャッシュをリセットして、モジュール内の closure 状態（recentAloResults,
    // lastAloWarningAt）を初期化する。
    jest.resetModules();
  });

  it("recordAloResult が記録を蓄積し、getAloRejectionStats で集計できる", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordAloResult, getAloRejectionStats } = require("../../src/risk/monitor");

    recordAloResult(false);
    recordAloResult(true);
    recordAloResult(false);
    recordAloResult(true);
    recordAloResult(true);

    const stats = getAloRejectionStats();
    expect(stats.sampleCount).toBe(5);
    expect(stats.rejectedCount).toBe(3);
    expect(stats.rate).toBeCloseTo(0.6, 5);
  });

  it("サンプルサイズ上限を超えると古いものが FIFO で削除される", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      recordAloResult,
      getAloRejectionStats,
    } = require("../../src/risk/monitor");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EXECUTION_PARAMS } = require("../../src/core/config");
    const limit = EXECUTION_PARAMS.aloRejectionSampleSize;

    // 上限 + 10 件を投入（最初の 10 件は押し出される）
    for (let i = 0; i < limit; i++) recordAloResult(false); // 初期 100 件すべて成功
    for (let i = 0; i < 10; i++) recordAloResult(true); // 後から 10 件拒否

    const stats = getAloRejectionStats();
    expect(stats.sampleCount).toBe(limit);
    // 最初の 10 件の成功が押し出されて、末尾 10 件が拒否に変わっている
    expect(stats.rejectedCount).toBe(10);
  });

  it("monitorAloRejectionRate: サンプル不足時は警告を出さない", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      recordAloResult,
      monitorAloRejectionRate,
    } = require("../../src/risk/monitor");
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    // 10 件だけ（aloRejectionSampleSize=100 の半分未満）
    for (let i = 0; i < 10; i++) recordAloResult(true);

    monitorAloRejectionRate();
    expect(warnSpy).not.toHaveBeenCalled();

  });

  it("monitorAloRejectionRate: 拒否率 20% 未満では警告を出さない", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      recordAloResult,
      monitorAloRejectionRate,
    } = require("../../src/risk/monitor");
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    // 50 件成功、10 件拒否 → 16.7%
    for (let i = 0; i < 50; i++) recordAloResult(false);
    for (let i = 0; i < 10; i++) recordAloResult(true);

    monitorAloRejectionRate();
    expect(warnSpy).not.toHaveBeenCalled();

  });

  it("monitorAloRejectionRate: 拒否率 20% 以上で警告ログを出す", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      recordAloResult,
      monitorAloRejectionRate,
    } = require("../../src/risk/monitor");
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    // 60 件（成功 40, 拒否 20 → 33.3%）
    for (let i = 0; i < 40; i++) recordAloResult(false);
    for (let i = 0; i < 20; i++) recordAloResult(true);

    monitorAloRejectionRate();
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("POST_ONLY 拒否率が高い");
    expect(msg).toContain("60 件中 20 件");

  });

  it("monitorAloRejectionRate: クールダウン中（1時間以内）は再通知しない", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      recordAloResult,
      monitorAloRejectionRate,
    } = require("../../src/risk/monitor");
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    // 拒否率超過のデータを投入
    for (let i = 0; i < 40; i++) recordAloResult(false);
    for (let i = 0; i < 20; i++) recordAloResult(true);

    monitorAloRejectionRate();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // 再度呼んでもクールダウン中なので通知されない
    monitorAloRejectionRate();
    expect(warnSpy).toHaveBeenCalledTimes(1);

  });
});
