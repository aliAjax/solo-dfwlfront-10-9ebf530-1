/* 并发“标签”worker：每个 localStorage key 一个独立文件，模拟真实多标签共享存储 */
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
  const { useInspectionStore, readLatest } = await import("../src/store");
  const op = workerData.op;
  await new Promise((r) => setTimeout(r, workerData.delay));

  let result;
  if (op === "generate") {
    result = await useInspectionStore.getState().generate(
      workerData.date, "morning", ["加油区", "油罐区", "收银区"]
    );
  } else if (op === "remove") {
    result = await useInspectionStore.getState().remove(workerData.recordId);
  } else if (op === "status") {
    result = await useInspectionStore.getState().changeStatus(
      workerData.recordId,
      workerData.target,
      workerData.input
    );
  } else if (op === "reset") {
    result = await useInspectionStore.getState().resetAll();
  }
  // 回传结果 + 该标签此刻读到的该记录快照，供主进程核对“无状态回退”
  let snapshot = null;
  if (workerData.recordId) {
    const rec = readLatest().find((r) => r.id === workerData.recordId);
    snapshot = rec
      ? {
          exists: true,
          events: rec.statusEvents.length,
          last: rec.statusEvents[rec.statusEvents.length - 1]?.status ?? null,
        }
      : { exists: false, events: 0, last: null };
  }
  parentPort.postMessage({ result, snapshot });
})();
