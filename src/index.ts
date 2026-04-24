import dotenv from "dotenv";
dotenv.config();

import { initDb } from "./db/database";
import { getDnPairsByStatus, updateDnPairStatus } from "./db/positions";
import { startAllJobs, stopAllJobs } from "./scheduler/jobs";
import { runScreening } from "./analyzers/screener";
import { detectArbitrageOpportunities } from "./analyzers/funding-arbitrage";
import {
  refreshAssetCache,
  getAccountState as getHlAccount,
} from "./execution/hl-executor";
import {
  refreshMarketCache,
  getAccountState as getExtAccount,
} from "./execution/ext-executor";
import { setInitialEquity, generateRiskReport } from "./risk/monitor";
import { setDryRun } from "./strategy/dn-strategy";

async function main(): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Delta-Neutral Bot 起動中...");
  console.log("  Hyperliquid × Extended");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // 1. DB初期化
  try {
    initDb();
  } catch (err) {
    console.error(`[致命的] DB初期化失敗: ${err}`);
    process.exit(1);
  }

  // 2. ゴーストペア検出（前回プロセスクラッシュの残骸）
  {
    const openingPairs = getDnPairsByStatus("opening");
    const manualPairs = getDnPairsByStatus("manual_review");

    if (openingPairs.length > 0) {
      console.warn(`[初期化] ゴーストペア検出: ${openingPairs.length}件の opening 状態`);
      for (const p of openingPairs) {
        console.warn(
          `  #${p.id} ${p.symbol} opening since ${p.createdAt.toISOString()} → manual_review に変更`
        );
        updateDnPairStatus(p.id, "manual_review", {
          closeReason: "起動時ゴースト検出: プロセスクラッシュの可能性",
        });
      }
    }

    if (manualPairs.length > 0) {
      console.warn(
        `[初期化] manual_review ペアが${manualPairs.length}件あります。該当銘柄は新規エントリー不可。`
      );
      for (const p of manualPairs) {
        console.warn(`  #${p.id} ${p.symbol} (${p.closeReason ?? "理由不明"})`);
      }
    }
  }

  // 3. 実行エンジンのキャッシュ初期化
  try {
    console.log("\n[初期化] アセット・マーケットキャッシュ構築...");
    await Promise.all([refreshAssetCache(), refreshMarketCache()]);
  } catch (err) {
    console.warn(`[警告] キャッシュ初期化失敗（継続）: ${err}`);
  }

  // 3.5. 幻影 manual_review ペアの自動クリーンアップ
  // 条件: status=manual_review AND long_size=0 AND short_size=0 AND openedAt=null
  // 上記を満たすペアは「AMBIGUOUS 発動したが実ポジションが発生しなかった」可能性が高い。
  // 取引所側を照会し両ベニューでポジション 0 件を確認できたら自動 closed 化。
  try {
    const manualPairsForCleanup = getDnPairsByStatus("manual_review");
    const phantomCandidates = manualPairsForCleanup.filter(
      (p) =>
        p.longSize === 0 &&
        p.shortSize === 0 &&
        p.openedAt === null
    );

    if (phantomCandidates.length > 0) {
      console.log(
        `\n[初期化] 幻影 manual_review 候補 ${phantomCandidates.length}件を検出 → 取引所照会で安全確認`
      );

      let hlPositions: Array<{ coin: string; size: number }> = [];
      let extPositions: Array<{ market: string; size: number }> = [];
      try {
        const [hlState, extState] = await Promise.all([
          getHlAccount(),
          getExtAccount(),
        ]);
        hlPositions = hlState.positions.map((p) => ({
          coin: p.coin,
          size: p.size,
        }));
        extPositions = extState.positions.map((p) => ({
          market: p.market,
          size: p.size,
        }));
      } catch (err) {
        console.warn(
          `[初期化] 幻影クリーンアップ: 取引所照会失敗、全候補を manual_review のまま保持 (${err instanceof Error ? err.message : String(err)})`
        );
      }

      let cleanedCount = 0;
      for (const p of phantomCandidates) {
        const hlHas = hlPositions.some(
          (x) => x.coin === p.symbol && x.size !== 0
        );
        const extHas = extPositions.some(
          (x) => x.market === `${p.symbol}-USD` && x.size !== 0
        );

        if (!hlHas && !extHas) {
          updateDnPairStatus(p.id, "closed", {
            closeReason:
              "Auto-closed phantom manual_review (verified no positions on both venues)",
          });
          console.log(
            `  ✓ #${p.id} ${p.symbol} → closed（HL/EXT ともにポジションなしを確認）`
          );
          cleanedCount++;
        } else {
          console.log(
            `  ✗ #${p.id} ${p.symbol} → manual_review 維持（HL=${hlHas} EXT=${extHas}、実ポジションあり）`
          );
        }
      }

      if (cleanedCount > 0) {
        console.log(
          `[初期化] 幻影クリーンアップ完了: ${cleanedCount}件を closed 化`
        );
      }
    }
  } catch (err) {
    console.warn(`[警告] 幻影クリーンアップ処理エラー（継続）: ${err}`);
  }

  // 4. 動作モード
  // DRY_RUN=false のみが本番。それ以外（未設定・typo・"FALSE"・"0"等）は全て安全側（ドライラン）。
  const rawDryRun = process.env.DRY_RUN;
  const isLive = rawDryRun === "false";
  if (!isLive && rawDryRun !== "true" && rawDryRun !== undefined) {
    console.warn(
      `[初期化] DRY_RUN="${rawDryRun}" — "false" 以外は全てドライラン扱いです`
    );
  }
  setDryRun(!isLive);

  // 5. 初回リスクレポート → 初期エクイティ設定
  try {
    console.log("\n[初期化] 初回リスクチェック...");
    const riskReport = await generateRiskReport();
    if (riskReport.totalEquity > 0) {
      setInitialEquity(riskReport.totalEquity);
    }
  } catch (err) {
    console.warn(`[警告] 初回リスクチェック失敗（継続）: ${err}`);
  }

  // 6. 初回スクリーニング実行
  try {
    console.log("\n[初期化] 初回スクリーニング実行...");
    await runScreening();
  } catch (err) {
    console.warn(`[警告] 初回スクリーニング失敗（継続）: ${err}`);
  }

  // 7. 初回FR裁定検出
  try {
    console.log("\n[初期化] 初回FR裁定検出...");
    await detectArbitrageOpportunities();
  } catch (err) {
    console.warn(`[警告] 初回FR裁定検出失敗（継続）: ${err}`);
  }

  // 8. スケジューラ起動
  startAllJobs();

  const modeLabel = isLive ? "本番（実注文あり）" : "ドライラン（実注文なし）";
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Delta-Neutral Bot 起動完了");
  console.log(`  モード: ${modeLabel}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // グレースフルシャットダウン
  const shutdown = (): void => {
    console.log("\n[シャットダウン] 停止中...");
    stopAllJobs();
    console.log("[シャットダウン] 完了");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[致命的] 予期せぬエラー: ${err}`);
  process.exit(1);
});
