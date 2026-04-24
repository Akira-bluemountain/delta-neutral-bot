/**
 * DB マイグレーションランナー（Phase A Task A1）
 *
 * src/db/migrations/*.sql を起動時に順次適用する。
 * 適用済みマイグレーションは schema_migrations テーブルで管理し、
 * 同一マイグレーションが 2 回実行されないことを保証する。
 *
 * マイグレーションファイル命名規則: YYYYMMDD_<description>.sql
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

interface MigrationRecord {
  id: string;
  applied_at: string;
}

/**
 * schema_migrations テーブルを初期化し、未適用のマイグレーションを全て実行する。
 * べき等: 同じマイグレーションを 2 回実行してもエラーにならない。
 */
export function runMigrations(db: Database.Database): void {
  // schema_migrations テーブルがなければ作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // migrations ディレクトリが存在しなければ skip
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return;
  }

  // 適用済み ID を取得
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as MigrationRecord[]).map(
      (r) => r.id
    )
  );

  // .sql ファイル一覧を取得してソート（名前順 = 日付順）
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    if (applied.has(id)) continue;

    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, "utf-8");

    try {
      const runMigration = db.transaction(() => {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(id);
      });
      runMigration();
      console.log(`[DB] マイグレーション適用: ${id}`);
    } catch (err) {
      // SQLite の ALTER TABLE ADD COLUMN は同じカラムを 2 回追加するとエラーになるが、
      // 既に適用されているケース（schema_migrations 記録漏れ等）を許容する
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate column name")) {
        // 既存カラムがあるだけ → 記録だけ残して続行
        db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)").run(id);
        console.log(`[DB] マイグレーション既適用を検知: ${id}`);
      } else {
        console.error(`[DB] マイグレーション失敗 ${id}: ${msg}`);
        throw err;
      }
    }
  }
}
