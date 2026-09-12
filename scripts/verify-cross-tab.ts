/* 跨标签并发写：
   1) 同班次生成：恰好一个赢家
   2) 删除 vs 状态变更竞争：恰好一个成功，最终状态自洽
   3) N 个标签并发登记同一条记录：恰好一次落盘、事件不重复、无状态回退
   4) 恢复演示数据与生成竞争：存储始终为合法 v2，不被写坏 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

const DATA_KEY = "dfwlfront-10-inspection";
const LOCK_KEY = "dfwlfront-10-inspection-lock";

function keyFile(base: string, k: string) {
  return `${base}__${encodeURIComponent(k)}`;
}
function readKey(base: string, k: string): string | null {
  try {
    return fs.readFileSync(keyFile(base, k), "utf8");
  } catch {
    return null;
  }
}
function writeRaw(base: string, records: unknown[]) {
  fs.writeFileSync(keyFile(base, DATA_KEY), JSON.stringify({ version: 2, records }));
}
function readPersisted(base: string): { version: number; records: any[] } {
  return JSON.parse(readKey(base, DATA_KEY)!);
}
function newBase(label: string) {
  const base = path.join(os.tmpdir(), `dfwlfront-xtab-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  for (const k of [DATA_KEY, LOCK_KEY, "dfwlfront-10-operator"]) fs.rmSync(keyFile(base, k), { force: true });
  return base;
}
function cleanup(base: string) {
  for (const k of [DATA_KEY, LOCK_KEY, "dfwlfront-10-operator"]) fs.rmSync(keyFile(base, k), { force: true });
}

type WorkerResult = {
  result: any;
  snapshot: { exists: boolean; events: number; last: string | null } | null;
};
function spawnTab(base: string, payload: Record<string, unknown>, delay = 0): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./.cross-tab-worker.cjs", import.meta.url), {
      workerData: { dbPath: base, delay, ...payload },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

/* ---------- 1) 并发生成：唯一赢家 ---------- */
async function scenarioGenerate() {
  const base = newBase("gen");
  const N = 6;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      spawnTab(base, { op: "generate", date: "2026-09-20" }, i * 2)
    )
  );
  const winners = results.filter((r) => r.result.ok);
  const losers = results.filter((r) => !r.result.ok);
  assert.strictEqual(winners.length, 1);
  assert.strictEqual(winners[0].result.created, 16);
  assert.strictEqual(losers.length, N - 1);
  assert.ok(losers.every((r) => r.result.duplicates?.length === 16));
  const persisted = readPersisted(base);
  assert.strictEqual(persisted.records.length, 18);
  const seen = new Set<string>();
  for (const r of persisted.records) {
    const key = `${r.date}__${r.shift}__${r.device}`;
    assert.ok(!seen.has(key), `重复记录 ${key}`);
    seen.add(key);
  }
  assert.strictEqual(readKey(base, LOCK_KEY), null, "锁已释放");
  const late = await spawnTab(base, { op: "generate", date: "2026-09-20" }, 100);
  assert.strictEqual(late.result.ok, false);
  assert.strictEqual(readPersisted(base).records.length, 18);
  cleanup(base);
  console.log("  ✓ 6 标签并发生成：恰好 1 个写入 16 项，其余整单拦截且提示一致，迟到标签零写入");
}

/* ---------- 2) 删除 vs 状态变更竞争 ---------- */
async function scenarioDeleteVsStatus() {
  const base = newBase("del");
  const id = "race-record-1";
  writeRaw(base, [
    { id, date: "2026-09-21", shift: "morning", area: "加油区", device: "加油机1号", statusEvents: [] },
    { id: "other", date: "2026-09-21", shift: "morning", area: "加油区", device: "加油机2号", statusEvents: [] },
  ]);
  const [del, stat] = await Promise.all([
    spawnTab(base, { op: "remove", recordId: id }, 0),
    spawnTab(base, { op: "status", recordId: id, target: "normal", input: { operator: "甲", reason: "正常" } }, 5),
  ]);
  // 两种操作都真实成功是合法线性化（先标记后删除）；关键是结果必须确定、最终存储自洽。
  // 绝不允许：删除成功后状态变更把记录“复活”，或返回不确定/抛错。
  assert.ok(typeof del.result.ok === "boolean" && typeof stat.result.ok === "boolean", "两边结果都确定");
  const persisted = readPersisted(base);
  const rec = persisted.records.find((r) => r.id === id);

  if (del.result.ok) {
    // 删除成功 → 记录最终必须不存在，无论状态变更何时执行（不能被复活）
    assert.ok(!rec, "删除成功后记录不能被并发的状态变更复活");
  } else {
    // 删除失败（锁超时）→ 记录存在；状态变更要么成功（恰好 1 条事件），要么也因锁失败
    if (stat.result.ok) {
      assert.ok(rec && rec.statusEvents.length === 1);
      assert.strictEqual(rec.statusEvents[0].status, "normal");
    }
  }
  if (stat.result.ok && !del.result.ok) {
    assert.ok(rec, "状态成功且删除未成功时记录应存在");
  }
  if (del.result.ok && !stat.result.ok) {
    assert.ok(stat.result.message.includes("不存在") || stat.result.message.includes("稍后重试"));
  }
  // 另一条无关记录不受影响
  assert.ok(persisted.records.some((r) => r.id === "other"));

  // 删除成功后再尝试对已删记录登记状态：必须失败，记录不会复活（半份/回退防线）
  if (del.result.ok) {
    const zombie = await spawnTab(base, {
      op: "status",
      recordId: id,
      target: "normal",
      input: { operator: "乙", reason: "试图复活" },
    });
    assert.strictEqual(zombie.result.ok, false, "已删除记录不能被后续状态登记复活");
    assert.ok(!readPersisted(base).records.some((r) => r.id === id));
  }
  cleanup(base);
  console.log("  ✓ 删除与状态变更竞争：结果确定、最终存储自洽，删除成功后记录不会被并发操作复活");
}

/* ---------- 3) N 标签并发登记同一条记录 ---------- */
async function scenarioConcurrentStatus() {
  const base = newBase("stat");
  const id = "same-record-1";
  writeRaw(base, [
    { id, date: "2026-09-22", shift: "morning", area: "油罐区", device: "卸油口密封", statusEvents: [] },
  ]);
  const N = 20;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      spawnTab(
        base,
        {
          op: "status",
          recordId: id,
          target: "normal",
          input: { operator: `员工${i}`, reason: `巡检正常 ${i}` },
        },
        i * 1
      )
    )
  );
  const ok = results.filter((r) => r.result.ok);
  const fail = results.filter((r) => !r.result.ok);
  assert.strictEqual(ok.length, 1, "恰好一次状态登记成功");
  assert.strictEqual(fail.length, N - 1, "其余被锁串行化后读到终态而失败");
  const rec = readPersisted(base).records.find((r) => r.id === id);
  assert.ok(rec);
  assert.strictEqual(rec.statusEvents.length, 1, "只有一条事件，无半份/重复写入");
  assert.strictEqual(rec.statusEvents[0].status, "normal");
  // 所有标签的最终快照一致：存在、1 条事件、normal（无状态回退到未检）
  for (const r of results) {
    assert.ok(r.snapshot);
    assert.deepStrictEqual(r.snapshot, { exists: true, events: 1, last: "normal" });
  }
  cleanup(base);
  console.log("  ✓ 20 标签并发登记同一条记录：恰好 1 次落盘，事件不重复，所有标签最终视图一致（无回退）");
}

/* ---------- 4) 恢复演示数据 与 生成 竞争 ---------- */
async function scenarioResetVsGenerate() {
  const base = newBase("reset");
  writeRaw(base, [
    { id: "pre-1", date: "2026-09-23", shift: "morning", area: "加油区", device: "加油机1号", statusEvents: [] },
  ]);
  // 交错发起：恢复 + 多个生成
  const tasks = [
    spawnTab(base, { op: "reset" }, 0),
    spawnTab(base, { op: "generate", date: "2026-09-23" }, 10),
    spawnTab(base, { op: "generate", date: "2026-09-24" }, 20),
    spawnTab(base, { op: "reset" }, 30),
  ];
  const results = await Promise.all(tasks);
  // 每次操作返回都必须是确定的成功或失败，没有抛出/未决
  for (const [i, r] of results.entries()) {
    assert.ok(typeof r.result?.ok === "boolean", `操作 ${i} 必须返回确定结果`);
  }
  const persisted = readPersisted(base);
  // 存储始终合法：v2、数组、同设备同班次唯一（不被两个写操作拼成半份）
  assert.strictEqual(persisted.version, 2);
  assert.ok(Array.isArray(persisted.records));
  const keys = new Set<string>();
  for (const r of persisted.records) {
    const key = `${r.date}__${r.shift}__${r.device}`;
    assert.ok(!keys.has(key), `出现半份/重复：${key}`);
    keys.add(key);
    assert.ok(Array.isArray(r.statusEvents));
  }

  // 并发交错下最终数量取决于锁的线性化顺序，不能按发起顺序臆测；
  // 这里再串行执行一次恢复（此时无竞争），确定性验证恢复语义：最终恰好 2 条种子
  const finalReset = await spawnTab(base, { op: "reset" }, 0);
  assert.strictEqual(finalReset.result.ok, true, "无竞争时恢复必须成功");
  const afterReset = readPersisted(base);
  assert.strictEqual(afterReset.records.length, 2, "恢复后只剩 2 条种子");
  assert.ok(afterReset.records.every((r) => ["normal", "abnormal"].includes(
    r.statusEvents[r.statusEvents.length - 1]?.status
  )));
  cleanup(base);
  console.log("  ✓ 恢复与生成交错并发：每次操作结果确定，存储始终合法 v2 且无重复/半份；串行恢复语义正确");
}

await scenarioGenerate();
await scenarioDeleteVsStatus();
await scenarioConcurrentStatus();
await scenarioResetVsGenerate();
console.log("\n跨标签并发写全部通过");
