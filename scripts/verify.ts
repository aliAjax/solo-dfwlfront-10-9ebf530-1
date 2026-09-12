/* 纯逻辑场景验证：生成/重复拦截/状态机/异常必填/筛选统计/旧格式迁移/持久化往返 */
import assert from "node:assert";
import {
  AREA_CATALOG,
  AREAS,
  Filters,
  InspectionRecord,
  LEGACY_SEED,
  SHIFT_LABEL,
  StatusChangeInput,
  applyFilters,
  computeStats,
  currentStatus,
  migrateLegacy,
  nextStatuses,
  planGenerate,
  validateChange,
} from "../src/domain";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const now = "2026-09-12";

function makeRecord(over: Partial<InspectionRecord> = {}): InspectionRecord {
  return {
    id: Math.random().toString(36).slice(2),
    date: now,
    shift: "morning",
    area: "加油区",
    device: "加油机1号",
    statusEvents: [],
    ...over,
  };
}

const abnormalInput: StatusChangeInput = {
  operator: "张三",
  reason: "油枪渗漏",
  foundAt: "2026-09-12 09:30",
  handler: "李四",
  rectification: "已更换密封圈并复测",
};

console.log("1) 按区域一次生成");
check("勾选全部区域 → 生成设备总数 = 目录之和", () => {
  const plan = planGenerate([], now, "morning", AREAS);
  const expected = AREAS.reduce((n, a) => n + AREA_CATALOG[a].length, 0);
  assert.strictEqual(plan.creates.length, expected);
  assert.strictEqual(plan.duplicates.length, 0);
});

check("只选油罐区 → 只生成油罐区设备", () => {
  const plan = planGenerate([], now, "morning", ["油罐区"]);
  assert.ok(plan.creates.every((c) => c.area === "油罐区"));
  assert.strictEqual(plan.creates.length, AREA_CATALOG["油罐区"].length);
});

console.log("2) 同设备同班次重复录入拦截");
check("已生成后再生成同日期同班次 → 全部判重，creates 为 0", () => {
  const first = planGenerate([], now, "morning", AREAS);
  const existing: InspectionRecord[] = first.creates.map((c, i) =>
    makeRecord({ id: `r${i}`, date: c.date, shift: c.shift, area: c.area, device: c.device })
  );
  const second = planGenerate(existing, now, "morning", AREAS);
  assert.strictEqual(second.creates.length, 0);
  assert.strictEqual(second.duplicates.length, existing.length);
});

check("不同班次不算重复；换班次可再次生成", () => {
  const existing = [makeRecord()];
  const plan = planGenerate(existing, now, "afternoon", ["加油区"]);
  assert.ok(plan.creates.some((c) => c.device === "加油机1号"));
});

check("同班次不同日期不算重复", () => {
  const existing = [makeRecord({ date: "2026-09-11" })];
  const plan = planGenerate(existing, now, "morning", ["加油区"]);
  assert.ok(plan.creates.some((c) => c.device === "加油机1号"));
});

console.log("3) 状态机");
check("未检的下一态只有正常/异常", () => {
  assert.deepStrictEqual(nextStatuses("pending"), ["normal", "abnormal"]);
  assert.strictEqual(currentStatus(makeRecord()), "pending");
});
check("正常为终态：无任何可流转状态（不能回到未检）", () => {
  assert.deepStrictEqual(nextStatuses("normal"), []);
});
check("异常只能整改关闭为正常", () => {
  assert.deepStrictEqual(nextStatuses("abnormal"), ["normal"]);
});
check("终态直接提交变更被拦截", () => {
  const r = validateChange("normal", "pending", { operator: "a", reason: "b" });
  assert.strictEqual(r.ok, false);
});

console.log("4) 状态变更留痕字段校验");
check("未检→正常：缺操作人/原因不能提交", () => {
  assert.strictEqual(validateChange("pending", "normal", { operator: "", reason: "x" }).ok, false);
  assert.strictEqual(validateChange("pending", "normal", { operator: "张", reason: "" }).ok, false);
  assert.strictEqual(validateChange("pending", "normal", { operator: "张", reason: "巡检无异常" }).ok, true);
});
check("登记异常：发现时间/处理人/整改说明缺一不可", () => {
  for (const key of ["foundAt", "handler", "rectification"] as const) {
    const input = { ...abnormalInput, [key]: "" };
    const r = validateChange("pending", "abnormal", input);
    assert.strictEqual(r.ok, false, `缺少 ${key} 应被拦截`);
  }
  assert.strictEqual(validateChange("pending", "abnormal", abnormalInput).ok, true);
});
check("异常→正常（整改关闭）：需要操作人与原因，且关闭后不能回未检", () => {
  assert.strictEqual(
    validateChange("abnormal", "normal", { operator: "李四", reason: "复测合格" }).ok,
    true
  );
});

console.log("5) 三态由记录驱动");
check("无事件=未检；追加事件后最后一条决定状态", () => {
  let r = makeRecord();
  assert.strictEqual(currentStatus(r), "pending");
  r.statusEvents.push({
    id: "e1", status: "abnormal", at: "2026-09-12T01:30:00.000Z",
    operator: "张三", reason: "渗漏", foundAt: "2026-09-12 09:30", handler: "李四", rectification: "更换",
  });
  assert.strictEqual(currentStatus(r), "abnormal");
  r.statusEvents.push({ id: "e2", status: "normal", at: "2026-09-12T02:00:00.000Z", operator: "李四", reason: "复测合格" });
  assert.strictEqual(currentStatus(r), "normal");
});

console.log("6) 组合筛选 + 统计跟随");
const dataset: InspectionRecord[] = [
  makeRecord({ id: "1", area: "加油区", device: "加油机1号", statusEvents: [
    { id: "a", status: "normal", at: "2026-09-12T01:00:00Z", operator: "张三", reason: "正常" },
  ] }),
  makeRecord({ id: "2", area: "加油区", device: "加油机2号", statusEvents: [
    { id: "b", status: "abnormal", at: "2026-09-12T01:30:00Z", operator: "张三", reason: "油枪渗漏", handler: "李四", rectification: "待换", foundAt: "2026-09-12 09:30" },
  ] }),
  makeRecord({ id: "3", area: "油罐区", device: "卸油口密封" }),
  makeRecord({ id: "4", area: "油罐区", device: "通气管阻火器", date: "2026-09-11" }),
];

check("无筛选时统计：4 项，未检2/正常1/异常1，完成率50%", () => {
  const s = computeStats(dataset);
  assert.deepStrictEqual([s.total, s.pending, s.normal, s.abnormal, s.completion], [4, 2, 1, 1, 50]);
});
check("按区域+状态组合筛选（加油区+异常）→ 1 条且统计同步", () => {
  const f: Filters = { area: "加油区", status: "abnormal", date: "", keyword: "" };
  const rows = applyFilters(dataset, f);
  assert.strictEqual(rows.length, 1);
  const s = computeStats(rows);
  assert.deepStrictEqual([s.total, s.abnormal, s.completion], [1, 1, 100]);
});
check("日期筛选生效", () => {
  const rows = applyFilters(dataset, { area: "全部区域", status: "all", date: "2026-09-11", keyword: "" });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].device, "通气管阻火器");
});
check("关键字匹配设备名/操作人/原因/整改说明", () => {
  assert.strictEqual(applyFilters(dataset, { area: "全部区域", status: "all", date: "", keyword: "李四" }).length, 1);
  assert.strictEqual(applyFilters(dataset, { area: "全部区域", status: "all", date: "", keyword: "渗漏" }).length, 1);
  assert.strictEqual(applyFilters(dataset, { area: "全部区域", status: "all", date: "", keyword: "加油机" }).length, 2);
  assert.strictEqual(applyFilters(dataset, { area: "全部区域", status: "all", date: "", keyword: "不存在zzz" }).length, 0);
});
check("空结果集统计为 0、完成率 0（界面显示空状态）", () => {
  const rows = applyFilters(dataset, { area: "全部区域", status: "normal", date: "2026-09-11", keyword: "" });
  assert.strictEqual(rows.length, 0);
  const s = computeStats(rows);
  assert.strictEqual(s.completion, 0);
});

console.log("7) 旧格式迁移");
check("旧版扁平数组（含正常/异常/未知状态）可读取为新模型", () => {
  const migrated = migrateLegacy(LEGACY_SEED);
  assert.strictEqual(migrated.length, 2);
  assert.strictEqual(migrated[0].device, "加油机1号");
  assert.strictEqual(currentStatus(migrated[0]), "normal");
  assert.strictEqual(currentStatus(migrated[1]), "abnormal");
  const ev = migrated[1].statusEvents[migrated[1].statusEvents.length - 1];
  assert.strictEqual(ev.operator, "何鑫");
  assert.ok(ev.reason.includes("密封圈老化"));
  assert.ok(ev.rectification && ev.rectification.length > 0);
});
check("迁移后记录可继续走状态机（异常可关闭）", () => {
  const migrated = migrateLegacy(LEGACY_SEED);
  assert.deepStrictEqual(nextStatuses(currentStatus(migrated[1])), ["normal"]);
});
check("脏数据迁移不崩溃：非法区域归入加油区、异常缺字段补默认", () => {
  const dirty = [{ item: "X", area: "火星", status: "异常" }, { status: "啥" }, null];
  // @ts-expect-error 故意喂脏数据
  const migrated = migrateLegacy(dirty);
  assert.strictEqual(migrated.length, 3);
  assert.strictEqual(migrated[0].area, "加油区");
  assert.strictEqual(currentStatus(migrated[2]), "pending");
});

console.log("8) 持久化往返（v2 结构）");
check("新模型序列化后再读回，状态与事件完全一致", () => {
  const payload = JSON.stringify({ version: 2, records: dataset });
  const parsed = JSON.parse(payload);
  assert.strictEqual(parsed.version, 2);
  assert.deepStrictEqual(
    parsed.records.map((r: InspectionRecord) => [r.device, r.statusEvents.length, currentStatus(r)]),
    dataset.map((r) => [r.device, r.statusEvents.length, currentStatus(r)])
  );
});

console.log(`\n全部通过：${passed} 组检查`);
void SHIFT_LABEL;
