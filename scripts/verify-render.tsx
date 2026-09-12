/* 首屏 SSR 渲染冒烟：确认组件树在“旧格式种子 + 默认今天筛选”下不抛错 */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
}
(globalThis as { localStorage: MemoryStorage; matchMedia?: unknown }).localStorage = new MemoryStorage();

// 刷新场景：模拟浏览器里已存有旧版扁平数组（PRELOAD_LEGACY=1）
if (process.env.PRELOAD_LEGACY === "1") {
  const { STORAGE_KEY } = await import("../src/store");
  const { LEGACY_SEED } = await import("../src/domain");
  localStorage.setItem(STORAGE_KEY, JSON.stringify(LEGACY_SEED));
}
// antd 部分组件在渲染期探测 matchMedia
(globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({
  matches: false, media: q, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
});

const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: App } = await import("../src/App");

let html = "";
try {
  html = renderToStaticMarkup(React.createElement(App));
} catch (err) {
  console.error("渲染失败：", err);
  process.exit(1);
}

const mustContain = [
  "油站设备巡检清单",
  "当班巡检生成",
  "巡检记录",
  "加油机1号",      // 旧格式种子迁移后可见
  "卸油口密封",
  "全部区域",
];
let missing = mustContain.filter((s) => !html.includes(s));
if (missing.length) {
  console.error("首屏缺少内容：", missing);
  process.exit(1);
}
console.log(`✓ 首屏渲染成功（${html.length} 字符），关键内容齐全：`);
for (const s of mustContain) console.log(`  - ${s}`);
