/* 并发“标签”worker：每个 localStorage key 对应一个独立文件，
   与真实浏览器一致——不同 key 的写入互不覆盖；同一 key 通过临时文件+rename 原子替换。 */
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");

const DB_PATH = workerData.dbPath;

function keyPath(k) {
  return `${DB_PATH}__${encodeURIComponent(k)}`;
}

class FileStorage {
  getItem(k) {
    try {
      return fs.readFileSync(keyPath(k), "utf8");
    } catch {
      return null;
    }
  }
  setItem(k, v) {
    const p = keyPath(k);
    const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, String(v));
    fs.renameSync(tmp, p);
  }
  removeItem(k) {
    try {
      fs.unlinkSync(keyPath(k));
    } catch {
      // ignore
    }
  }
}
globalThis.localStorage = new FileStorage();

(async () => {
  const { useInspectionStore } = await import("../src/store");
  // 每个 worker 在随机微小时延后同时发起同一日期/班次/区域的生成
  await new Promise((r) => setTimeout(r, workerData.delay));
  const result = await useInspectionStore.getState().generate(
    "2026-09-20", "morning", ["加油区", "油罐区", "收银区"]
  );
  parentPort.postMessage({
    ok: result.ok,
    created: result.ok ? result.created : 0,
    duplicates: result.ok ? [] : result.duplicates,
  });
})();
