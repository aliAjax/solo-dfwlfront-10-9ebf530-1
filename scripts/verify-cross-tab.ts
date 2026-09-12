/* 跨标签并发：N 个 worker（每个一个独立 store 实例 + 共享的文件式 localStorage）同时生成同一班次 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

const TABS = 6;
const base = path.join(os.tmpdir(), `dfwlfront-cross-tab-${process.pid}`);
const DATA_KEY = "dfwlfront-10-inspection";
const LOCK_KEY = "dfwlfront-10-inspection-lock";

function keyFile(k: string) {
  return `${base}__${encodeURIComponent(k)}`;
}
function readKey(k: string): string | null {
  try {
    return fs.readFileSync(keyFile(k), "utf8");
  } catch {
    return null;
  }
}
function cleanup() {
  for (const k of [DATA_KEY, LOCK_KEY, "dfwlfront-10-operator"]) {
    fs.rmSync(keyFile(k), { force: true });
  }
}
cleanup();

function spawnTab(delay: number): Promise<{ ok: boolean; created: number; duplicates: string[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./.cross-tab-worker.cjs", import.meta.url), {
      workerData: { dbPath: base, delay },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

function readPersisted() {
  return JSON.parse(readKey(DATA_KEY)!) as { version: number; records: Array<Record<string, unknown>> };
}

console.log(`并发场景：${TABS} 个标签同时生成 2026-09-20 早班全部区域（16 台设备）`);
const results = await Promise.all(
  Array.from({ length: TABS }, (_, i) => spawnTab(i * 2))
);

const winners = results.filter((r) => r.ok);
const losers = results.filter((r) => !r.ok);

console.log(`  成功 ${winners.length} 个，被拦截 ${losers.length} 个`);

assert.strictEqual(winners.length, 1, "必须恰好一个标签成功");
assert.strictEqual(winners[0].created, 16, "成功标签一次写入 16 项");
assert.strictEqual(losers.length, TABS - 1, "其余标签全部被拦截");
assert.ok(
  losers.every((r) => r.duplicates.length === 16),
  "每个被拦截标签看到的重复项必须与拦截判定一致（16 项）"
);

// 落盘结果：种子 2 + 16 = 18，绝不能出现 32/48…
const persisted = readPersisted();
assert.strictEqual(persisted.version, 2);
assert.strictEqual(persisted.records.length, 18, "只允许写入一份（18 = 2 种子 + 16 新生成）");

// 唯一性：同一设备同一班次只有一条
const seen = new Set<string>();
for (const r of persisted.records as Array<{ date: string; shift: string; device: string }>) {
  const key = `${r.date}__${r.shift}__${r.device}`;
  assert.ok(!seen.has(key), `出现重复记录：${key}`);
  seen.add(key);
}
assert.strictEqual([...seen].filter((k) => k.startsWith("2026-09-20__morning__")).length, 16);

// 锁必须已释放（无残留）
assert.ok(readKey(LOCK_KEY) === null, "事务结束后锁应释放");

// 再来一个迟到的标签：整单拦截且零写入
const late = await spawnTab(200);
assert.strictEqual(late.ok, false, "迟到标签必须被拦截");
assert.strictEqual(late.duplicates.length, 16, "提示与拦截一致：16 项重复");
assert.strictEqual(readPersisted().records.length, 18, "被拦截后记录数不得变化");

cleanup();
console.log("  ✓ 恰好 1 个标签写入 16 项，其余 5 个标签整单拦截且重复项一致");
console.log("  ✓ 存储中同设备同班次唯一，总数 18，无半份写入，锁已释放");
console.log("  ✓ 迟到标签同样被拦截且零写入");
console.log("\n跨标签并发验证通过");
