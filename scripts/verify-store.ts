/* Store + localStorage 集成：
   原子拦截、最新存储判定、锁、落盘失败注入、失败不假成功且可重试、storage 同步、旧格式升级 */
import assert from "node:assert";

class MemoryStorage {
  private map = new Map<string, string>();
  /** 打开后写入数据 key 会抛错（模拟配额超限 / 存储被禁用） */
  failDataWrite = false;
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (this.failDataWrite && k === "dfwlfront-10-inspection") {
      throw new Error("QuotaExceededError: setItem failed");
    }
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
const storage = new MemoryStorage();
(globalThis as { localStorage: MemoryStorage }).localStorage = storage;

const { STORAGE_KEY, LOCK_KEY, useInspectionStore, readLatest } = await import("../src/store");
const { currentStatus, planGenerate } = await import("../src/domain");

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const count = () => JSON.parse(storage.getItem(STORAGE_KEY)!).records.length as number;
const get = () => useInspectionStore.getState();
const abnormalInput = {
  operator: "张三",
  reason: "胶管渗漏",
  foundAt: "2026-09-12 10:05",
  handler: "李四",
  rectification: "更换胶管并复测",
};

await check("首次进入：旧格式种子已落盘为 v2（多标签首次打开也一致）", () => {
  const saved = JSON.parse(storage.getItem(STORAGE_KEY)!);
  assert.strictEqual(saved.version, 2);
  assert.strictEqual(saved.records.length, 2);
});

await check("生成：整批写入（16 项）", async () => {
  const r = await get().generate("2026-09-12", "morning", ["加油区", "油罐区", "收银区"]);
  assert.strictEqual(r.ok, true);
  if (r.ok) assert.strictEqual(r.created, 16);
  assert.strictEqual(count(), 18);
});

await check("完全重复：整单拦截，记录数不变，duplicates 与判定同源（16 项）", async () => {
  const before = count();
  const r = await get().generate("2026-09-12", "morning", ["加油区", "油罐区", "收银区"]);
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.strictEqual(r.duplicates.length, 16);
  assert.strictEqual(count(), before);
});

await check("部分重叠：整单拦截，油罐区 5 项也不得写入；只勾不重复区域可成功", async () => {
  const before = count();
  const seed = await get().generate("2026-09-12", "afternoon", ["加油区"]);
  assert.strictEqual(seed.ok, true);
  const plan = planGenerate(readLatest(), "2026-09-12", "afternoon", ["加油区", "油罐区"]);
  assert.ok(plan.duplicates.length === 6 && plan.creates.length === 5);
  const r = await get().generate("2026-09-12", "afternoon", ["加油区", "油罐区"]);
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.strictEqual(r.duplicates.length, 6);
  assert.strictEqual(count(), before + 6);
  const r2 = await get().generate("2026-09-12", "afternoon", ["油罐区"]);
  assert.strictEqual(r2.ok, true);
});

await check("判定依据是最新存储而非内存：外部标签写入后本标签不重载也能拦截", async () => {
  const latest = readLatest();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    version: 2,
    records: [{ id: "foreign-1", date: "2026-09-12", shift: "night", area: "加油区", device: "加油机1号", statusEvents: [] }, ...latest],
  }));
  assert.strictEqual(get().records.some((r) => r.id === "foreign-1"), false);
  const r = await get().generate("2026-09-12", "night", ["加油区"]);
  assert.strictEqual(r.ok, false);
  assert.ok(get().records.some((r) => r.id === "foreign-1"), "失败/拦截后内存同步到最新");
});

/* ---------- 拿不到写锁：四类写操作都必须明确失败、零写入，原数据可读 ---------- */
await check("持锁期间：生成/状态变更/删除/恢复 全部失败、零写入、原数据可读", async () => {
  // 周期性刷新他标签的有效锁（4s TTL），保证四个串行操作期间锁始终有效
  const refresher = setInterval(() => {
    storage.setItem(LOCK_KEY, JSON.stringify({ token: "other-tab-lock", at: Date.now() }));
  }, 300);
  storage.setItem(LOCK_KEY, JSON.stringify({ token: "other-tab-lock", at: Date.now() }));

  const beforeCount = count();
  const target = readLatest().find((r) => r.statusEvents.length === 0)!;

  const rg = await get().generate("2026-10-01", "morning", ["收银区"]);
  const rs = await get().changeStatus(target.id, "normal", { operator: "甲", reason: "巡检正常" });
  const rd = await get().remove(target.id);
  const rr = await get().resetAll();

  for (const [name, r] of [["生成", rg], ["状态", rs], ["删除", rd], ["恢复", rr]] as const) {
    assert.strictEqual(r.ok, false, `${name} 拿不到锁不能成功`);
    if (!r.ok) assert.ok(r.message.includes("稍后重试"), `${name} 给出可重试提示：${r.message}`);
  }
  assert.strictEqual(count(), beforeCount, "锁拒绝期间零写入");
  assert.ok(readLatest().length === beforeCount, "原数据保持可读");
  assert.ok(get().records.length === beforeCount, "内存不假成功");

  clearInterval(refresher);
  storage.removeItem(LOCK_KEY);

  // 锁释放后同样参数可立即重试成功（删除最先执行，验证一个即可）
  const retry = await get().remove(target.id);
  assert.strictEqual(retry.ok, true);
  assert.strictEqual(count(), beforeCount - 1);
});

/* ---------- 浏览器存储写入失败：四类操作不假成功、不半份、可重试 ---------- */
await check("落盘失败：四类操作返回失败，存储与界面状态均不变", async () => {
  const beforeRaw = storage.getItem(STORAGE_KEY)!;
  const beforeCount = JSON.parse(beforeRaw).records.length;
  const target = readLatest().find((r) => r.statusEvents.length === 0)!;
  storage.failDataWrite = true;

  const rg = await get().generate("2026-10-02", "morning", ["加油区"]);
  const rs = await get().changeStatus(target.id, "abnormal", abnormalInput);
  const rd = await get().remove(target.id);
  const rr = await get().resetAll();

  for (const [name, r] of [["生成", rg], ["状态", rs], ["删除", rd], ["恢复", rr]] as const) {
    assert.strictEqual(r.ok, false, `${name} 落盘失败不能显示成功`);
    if (!r.ok) assert.ok(r.message.includes("存储") || r.message.includes("重试"), `${name} 明确失败提示：${r.message}`);
  }
  // 存储原封不动
  assert.strictEqual(storage.getItem(STORAGE_KEY), beforeRaw, "失败时存储字节不变");
  assert.strictEqual(count(), beforeCount);
  // 状态变更没有半份事件；记录仍未检
  const still = readLatest().find((r) => r.id === target.id)!;
  assert.strictEqual(still.statusEvents.length, 0);
  assert.strictEqual(currentStatus(still), "pending");
  // 恢复演示数据未生效：仍是 18 条业务数据
  assert.notStrictEqual(beforeCount, 2);
  // 内存与存储一致（不假成功、不回退）
  assert.strictEqual(get().records.length, beforeCount);

  storage.failDataWrite = false;
  const retryStatus = await get().changeStatus(target.id, "abnormal", abnormalInput);
  assert.strictEqual(retryStatus.ok, true, "存储恢复后可重试成功");
  assert.strictEqual(currentStatus(readLatest().find((r) => r.id === target.id)!), "abnormal");
});

/* ---------- 条件删除：不存在就是失败，绝不假成功 ---------- */
await check("删除不存在的记录返回失败；重复删除第二次失败", async () => {
  const ghost = await get().remove("no-such-id");
  assert.strictEqual(ghost.ok, false);
  if (!ghost.ok) assert.ok(ghost.message.includes("不存在"));

  const anyId = readLatest()[0].id;
  assert.strictEqual((await get().remove(anyId)).ok, true);
  const again = await get().remove(anyId);
  assert.strictEqual(again.ok, false, "已被其他标签删除后再删必须失败");
});

await check("状态变更：异常缺字段不写入；关闭后终态拦截（独立日期隔离）", async () => {
  const setup = await get().generate("2030-01-01", "morning", ["加油区"]);
  assert.strictEqual(setup.ok, true);
  const target = readLatest().find((x) => x.date === "2030-01-01" && x.device === "加油机1号")!;
  assert.ok(target);
  const bad = await get().changeStatus(target.id, "abnormal", { ...abnormalInput, foundAt: "" });
  assert.strictEqual(bad.ok, false);
  const ok = await get().changeStatus(target.id, "abnormal", abnormalInput);
  assert.strictEqual(ok.ok, true);
  const closed = await get().changeStatus(target.id, "normal", { operator: "李四", reason: "复测合格" });
  assert.strictEqual(closed.ok, true);
  const back = await get().changeStatus(target.id, "abnormal", abnormalInput);
  assert.strictEqual(back.ok, false);
  assert.strictEqual(currentStatus(readLatest().find((x) => x.id === target.id)!), "normal");
});

await check("过期锁（持锁标签崩溃）可被接管并正常生成，用完释放", async () => {
  storage.setItem(LOCK_KEY, JSON.stringify({ token: "dead-tab", at: Date.now() - 10_000 }));
  const r = await get().generate("2026-10-03", "morning", ["收银区"]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(storage.getItem(LOCK_KEY), null);
});

await check("syncFromStorage 可拿到外部最新写入（storage 事件路径）", () => {
  const withForeign = [
    { id: "foreign-sync", date: "2026-09-14", shift: "morning", area: "油罐区", device: "量油孔与阀门", statusEvents: [] },
    ...readLatest(),
  ];
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, records: withForeign }));
  get().syncFromStorage();
  assert.ok(get().records.some((r) => r.id === "foreign-sync"));
});

await check("模拟刷新/重开：记录与状态历史全部保留", () => {
  const reloaded = readLatest();
  assert.strictEqual(reloaded.length, count());
  assert.ok(reloaded.every((r) => Array.isArray(r.statusEvents)));
});

await check("旧版扁平数组缓存自动升级并可读", () => {
  storage.setItem(STORAGE_KEY, JSON.stringify([
    { item: "加油机1号", area: "加油区", inspector: "何鑫", checkedAt: "2026-06-30", status: "正常", notes: "无异常" },
  ]));
  const migrated = readLatest();
  assert.strictEqual(migrated.length, 1);
  assert.strictEqual(currentStatus(migrated[0]), "normal");
});

console.log(`\nStore 集成全部通过：${passed} 组检查`);
