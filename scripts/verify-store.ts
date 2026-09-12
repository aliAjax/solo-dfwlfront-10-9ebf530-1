/* Store + localStorage 集成：原子拦截、最新存储判定、锁、storage 同步、刷新、旧格式升级 */
import assert from "node:assert";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = () => JSON.parse(storage.getItem(STORAGE_KEY)!).records.length;
const get = () => useInspectionStore.getState();

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

await check("部分重叠：先只生成中班加油区，再勾 加油区+油罐区 → 整单拦截，油罐区也不得写入", async () => {
  const before = count();
  // 造“一半已存在”：中班只先有加油区
  const seed = await get().generate("2026-09-12", "afternoon", ["加油区"]);
  assert.strictEqual(seed.ok, true);
  const plan = planGenerate(readLatest(), "2026-09-12", "afternoon", ["加油区", "油罐区"]);
  assert.ok(plan.duplicates.length === 6 && plan.creates.length === 5); // 确实部分重叠
  const r = await get().generate("2026-09-12", "afternoon", ["加油区", "油罐区"]);
  assert.strictEqual(r.ok, false);
  if (!r.ok) assert.strictEqual(r.duplicates.length, 6, "提示的重复项与判定同源");
  assert.strictEqual(count(), before + 6, "存在重复时不得写入任何新记录（油罐区 5 项也不写）");
  // 只勾选不重复的油罐区可正常生成
  const r2 = await get().generate("2026-09-12", "afternoon", ["油罐区"]);
  assert.strictEqual(r2.ok, true);
});

await check("判定依据是最新存储而非内存：外部标签写入后，本标签不重新加载也能拦截", async () => {
  // 模拟“另一个标签”直接把夜班加油区写进 localStorage（绕过当前 store 内存）
  const latest = readLatest();
  const foreign = [
    {
      id: "foreign-1",
      date: "2026-09-12",
      shift: "night" as const,
      area: "加油区",
      device: "加油机1号",
      statusEvents: [],
    },
  ];
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, records: [...foreign, ...latest] }));
  // 内存里此刻还没有 foreign-1；生成必须读盘后拦截
  const inMemory = get().records.some((r) => r.id === "foreign-1");
  assert.strictEqual(inMemory, false);
  const r = await get().generate("2026-09-12", "night", ["加油区"]);
  assert.strictEqual(r.ok, false);
  // 拦截后本标签内存已同步到最新（看到另一个标签的结果）
  assert.ok(get().records.some((r) => r.id === "foreign-1"));
});

await check("其他标签持锁期间：本次生成失败且零写入", async () => {
  storage.setItem(
    LOCK_KEY,
    JSON.stringify({ token: "other-tab-lock", at: Date.now() })
  );
  const before = count();
  const r = await get().generate("2026-09-13", "morning", ["收银区"]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(count(), before);
  storage.removeItem(LOCK_KEY);
});

await check("过期锁（持锁标签崩溃）可被接管并正常生成", async () => {
  storage.setItem(
    LOCK_KEY,
    JSON.stringify({ token: "dead-tab", at: Date.now() - 10_000 })
  );
  const r = await get().generate("2026-09-13", "morning", ["收银区"]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(storage.getItem(LOCK_KEY), null, "用完应释放锁");
});

await check("同步调用 syncFromStorage 可拿到外部最新写入（storage 事件路径）", async () => {
  const withForeign = [
    {
      id: "foreign-sync",
      date: "2026-09-14",
      shift: "morning" as const,
      area: "油罐区",
      device: "量油孔与阀门",
      statusEvents: [],
    },
    ...readLatest(),
  ];
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, records: withForeign }));
  get().syncFromStorage();
  assert.ok(get().records.some((r) => r.id === "foreign-sync"));
});

await check("状态变更仍原子：异常缺字段不写入；关闭后终态拦截", async () => {
  const target = readLatest().find((x) => x.device === "加油机1号" && x.shift === "morning")!;
  const bad = await get().changeStatus(target.id, "abnormal", {
    operator: "张三", reason: "渗漏", foundAt: "", handler: "李四", rectification: "更换",
  });
  assert.strictEqual(bad.ok, false);
  const ok = await get().changeStatus(target.id, "abnormal", {
    operator: "张三", reason: "胶管渗漏", foundAt: "2026-09-12 10:05",
    handler: "李四", rectification: "更换胶管并复测",
  });
  assert.strictEqual(ok.ok, true);
  const closed = await get().changeStatus(target.id, "normal", {
    operator: "李四", reason: "复测合格",
  });
  assert.strictEqual(closed.ok, true);
  const back = await get().changeStatus(target.id, "abnormal", {
    operator: "x", reason: "y", foundAt: "t", handler: "h", rectification: "r",
  });
  assert.strictEqual(back.ok, false);
  assert.strictEqual(currentStatus(readLatest().find((x) => x.id === target.id)!), "normal");
});

await check("模拟刷新/重开：重新读取，记录与状态历史全部保留", () => {
  const reloaded = readLatest();
  assert.strictEqual(reloaded.length, count());
  assert.ok(reloaded.every((r) => Array.isArray(r.statusEvents)));
});

await check("旧版扁平数组缓存自动升级并可读", () => {
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      { item: "加油机1号", area: "加油区", inspector: "何鑫", checkedAt: "2026-06-30", status: "正常", notes: "无异常" },
    ])
  );
  const migrated = readLatest();
  assert.strictEqual(migrated.length, 1);
  assert.strictEqual(currentStatus(migrated[0]), "normal");
});

void sleep;
console.log(`\nStore 集成全部通过：${passed} 组检查`);
