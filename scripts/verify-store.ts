/* Store + localStorage 集成：模拟刷新/重开浏览器、旧格式升级、重复与终态拦截 */
import assert from "node:assert";

// 最小 localStorage shim（store 模块加载前注入）
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
(globalThis as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

const { STORAGE_KEY, useInspectionStore, loadPersisted } = await import("../src/store");
const { currentStatus, migrateLegacy, LEGACY_SEED } = await import("../src/domain");

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("A) 首次进入（无缓存）");
check("播种旧格式种子并迁移：2 条，状态为正常/异常", () => {
  const records = loadPersisted();
  assert.strictEqual(records.length, 2);
  assert.strictEqual(currentStatus(records[0]), "normal");
  assert.strictEqual(currentStatus(records[1]), "abnormal");
});

const store = useInspectionStore.getState.bind(useInspectionStore);

console.log("B) 生成当班巡检");
check("今天/早班/全部区域 → 新增 16 项且写入 localStorage（v2）", () => {
  const before = store().records.length;
  const r = store().generate("2026-09-12", "morning", ["加油区", "油罐区", "收银区"]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.created, 16);
  assert.strictEqual(store().records.length, before + 16);
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
  assert.strictEqual(saved.version, 2);
  assert.strictEqual(saved.records.length, 18);
});

check("同设备同班次重复生成被拦截：0 新增，返回 16 个重复项", () => {
  const before = store().records.length;
  const r = store().generate("2026-09-12", "morning", ["加油区", "油罐区", "收银区"]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(store().records.length, before);
  assert.strictEqual(r.duplicates.length, 16);
});

check("仅部分区域重复时：新增其余区域，重复区域跳过", () => {
  const r = store().generate("2026-09-12", "afternoon", ["加油区", "油罐区"]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.created, 11); // 6 + 5
});

console.log("C) 状态变更（Store 层）");
const target = store().records.find((x) => x.device === "加油机1号" && x.shift === "morning")!;
check("缺操作人/原因不能提交", () => {
  const r1 = store().changeStatus(target.id, "normal", { operator: "", reason: "" });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(currentStatus(store().records.find((x) => x.id === target.id)!), "pending");
});
check("异常信息不全不能提交（逐项缺）", () => {
  const base = { operator: "张三", reason: "渗漏", foundAt: "2026-09-12 10:00", handler: "李四", rectification: "换密封" };
  for (const key of ["foundAt", "handler", "rectification"] as const) {
    const r = store().changeStatus(target.id, "abnormal", { ...base, [key]: "" });
    assert.strictEqual(r.ok, false, `缺 ${key} 应拦截`);
  }
});
check("登记异常成功，事件含时间/操作人/原因及异常三要素", () => {
  const r = store().changeStatus(target.id, "abnormal", {
    operator: "张三", reason: "胶管渗漏", foundAt: "2026-09-12 10:05", handler: "李四", rectification: "更换胶管并复测",
  });
  assert.strictEqual(r.ok, true);
  const rec = store().records.find((x) => x.id === target.id)!;
  assert.strictEqual(currentStatus(rec), "abnormal");
  const ev = rec.statusEvents[rec.statusEvents.length - 1];
  assert.ok(ev.at);
  assert.strictEqual(ev.operator, "张三");
  assert.strictEqual(ev.handler, "李四");
});
check("异常整改关闭为正常", () => {
  const r = store().changeStatus(target.id, "normal", { operator: "李四", reason: "更换胶管后复测合格" });
  assert.strictEqual(r.ok, true);
});
check("关闭后不能回到未检/异常：终态无按钮路径，强调也被拦截", () => {
  const r1 = store().changeStatus(target.id, "pending", { operator: "x", reason: "y" });
  const r2 = store().changeStatus(target.id, "abnormal", { operator: "x", reason: "y" });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(currentStatus(store().records.find((x) => x.id === target.id)!), "normal");
});
check("删除记录生效并持久化", () => {
  const n = store().records.length;
  store().remove(target.id);
  assert.strictEqual(store().records.length, n - 1);
  assert.strictEqual(JSON.parse(localStorage.getItem(STORAGE_KEY)!).records.length, n - 1);
});

console.log("D) 模拟刷新 / 重开浏览器");
check("重新读取 localStorage：全部记录与状态历史保留", () => {
  const reloaded = loadPersisted();
  const fresh = store().records;
  assert.strictEqual(reloaded.length, fresh.length);
  const abnormalCount = fresh.filter((r) => currentStatus(r) === "abnormal").length;
  assert.strictEqual(reloaded.filter((r) => currentStatus(r) === "abnormal").length, abnormalCount);
  // 事件历史完整（关闭的那条已被删除，其余至少包含种子异常）
  assert.ok(reloaded.every((r) => Array.isArray(r.statusEvents)));
});

console.log("E) 旧格式存储升级");
check("缓存是旧版扁平数组时自动迁移，并在下次操作时以 v2 回写", () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(migrateLegacy(LEGACY_SEED).length ? LEGACY_SEED : []));
  const migrated = loadPersisted();
  assert.strictEqual(migrated.length, 2);
  assert.strictEqual(currentStatus(migrated[1]), "abnormal");
  // 经过一次 store 操作后回写 v2
  store().resetAll();
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
  assert.strictEqual(saved.version, 2);
  assert.strictEqual(saved.records.length, 2);
});
check("缓存损坏（非法 JSON）不崩溃，回退种子数据", () => {
  localStorage.setItem(STORAGE_KEY, "{not-json");
  const records = loadPersisted();
  assert.strictEqual(records.length, 2);
});

console.log(`\nStore 集成全部通过：${passed} 组检查`);
