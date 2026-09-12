import { create } from "zustand";
import {
  GenerateScope,
  InspectionRecord,
  LEGACY_SEED,
  Shift,
  StatusChangeInput,
  StatusEvent,
  currentStatus,
  migrateLegacy,
  nextStatuses,
  planGenerate,
  uid,
  validateChange,
} from "./domain";

const STORAGE_KEY = "dfwlfront-10-inspection";
const LOCK_KEY = "dfwlfront-10-inspection-lock";
const OPERATOR_KEY = "dfwlfront-10-operator";
const FORMAT_VERSION = 2;
/** 锁超时（毫秒）：持锁标签崩溃时，其他标签可在该时间后接管 */
const LOCK_TTL = 4000;
/**
 * 取得 tentative 锁后等待的稳定窗口：
 * localStorage 没有原子 CAS，写 token 后必须留出跨标签写入传播时间，
 * 再回读确认 token 仍是自己，避免两个标签同时通过检查进入临界区。
 */
const LOCK_SETTLE_MS = 60;
/** 等待锁的轮询间隔（带抖动）与最长等待时间 */
const LOCK_WAIT_MAX = 2500;

type PersistedShape = {
  version: typeof FORMAT_VERSION;
  records: InspectionRecord[];
};

export type ChangeResult =
  | { ok: true }
  | { ok: false; message: string };

/* ---------------- 读取 / 解析（始终以 localStorage 最新内容为准） ---------------- */

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** 防御性校验：任何来源的数据进入界面前补齐结构 */
function normalize(records: unknown): InspectionRecord[] {
  if (!Array.isArray(records)) return [];
  return records
    .filter((r): r is Partial<InspectionRecord> => !!r && typeof r === "object")
    .map((r, i) => ({
      id: typeof r.id === "string" ? r.id : `recovered-${i}`,
      date: typeof r.date === "string" ? r.date : "",
      shift: r.shift === "afternoon" || r.shift === "night" ? r.shift : "morning",
      area: typeof r.area === "string" ? r.area : "加油区",
      device: typeof r.device === "string" ? r.device : `未命名设备${i + 1}`,
      statusEvents: Array.isArray(r.statusEvents)
        ? (r.statusEvents as StatusEvent[]).filter((e) => e && typeof e.status === "string")
        : [],
    }));
}

/** 解析任意一份存储内容：支持旧版扁平数组、v2 包装、损坏内容回退种子 */
function parseStored(raw: string | null): InspectionRecord[] {
  if (!raw) return migrateLegacy(LEGACY_SEED);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return migrateLegacy(LEGACY_SEED);
  }
  if (Array.isArray(parsed)) {
    return migrateLegacy(parsed as never[]);
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as PersistedShape).version === FORMAT_VERSION &&
    Array.isArray((parsed as PersistedShape).records)
  ) {
    return normalize((parsed as PersistedShape).records);
  }
  return migrateLegacy(LEGACY_SEED);
}

/** 从 localStorage 重新读取最新数据（不信任标签内存） */
export function readLatest(): InspectionRecord[] {
  return parseStored(safeGetItem(STORAGE_KEY));
}

export function loadPersisted(): InspectionRecord[] {
  return readLatest();
}

function persist(records: InspectionRecord[]): boolean {
  return safeSetItem(STORAGE_KEY, JSON.stringify({ version: FORMAT_VERSION, records } satisfies PersistedShape));
}

/* ---------------- 跨标签互斥锁（两阶段确认，带 TTL 接管） ---------------- */

let lockToken = "";

function readLock(): { token: string; at: number } | null {
  const raw = safeGetItem(LOCK_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === "string" && typeof parsed.at === "number") {
      return parsed;
    }
  } catch {
    // 锁内容损坏，视为无主可接管
  }
  return null;
}

/**
 * 一次“尝试加锁”。localStorage 没有 CAS，无法原子地比较并写入，
 * 因此采用两阶段：先试探写入自己的 token，等待一个跨标签传播的稳定窗口，
 * 再回读确认锁仍属于自己。若稳定窗口内被竞争者覆盖，则本次尝试失败。
 * 返回 "owned"（拿到锁）、"held"（他人有效持锁，需等待）、"busy"（竞争失败，应退避重试）。
 */
async function tryAcquireOnce(): Promise<"owned" | "held" | "busy"> {
  const now = Date.now();
  const held = readLock();
  if (held && held.token !== lockToken && now - held.at < LOCK_TTL) {
    return "held";
  }
  // 锁不存在、已过期或内容损坏 → 试探接管
  const token = uid();
  lockToken = token;
  if (!safeSetItem(LOCK_KEY, JSON.stringify({ token, at: now }))) {
    lockToken = "";
    return "busy";
  }
  // 关键：等待并发的其他标签也完成各自的试探写入，再确认归属
  await sleep(LOCK_SETTLE_MS);
  const after = readLock();
  if (after && after.token === token) {
    // 刷新一次时间戳，标记锁仍然活跃
    safeSetItem(LOCK_KEY, JSON.stringify({ token, at: Date.now() }));
    return "owned";
  }
  // 被竞争者覆盖：本次尝试失败，退出等待下一轮（持锁方完成后会读到重复并拦截）
  lockToken = "";
  return "busy";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function releaseLock() {
  const held = readLock();
  if (held && held.token === lockToken) {
    try {
      localStorage.removeItem(LOCK_KEY);
    } catch {
      // ignore
    }
  }
  lockToken = "";
}

async function acquireLock(): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MAX;
  let attempt = 0;
  while (Date.now() < deadline) {
    const outcome = await tryAcquireOnce();
    if (outcome === "owned") return true;
    attempt += 1;
    // 指数退避 + 抖动，避免多个标签在同一时刻再次撞车
    const backoff = Math.min(120, 24 * attempt) + Math.floor(Math.random() * 30);
    await sleep(backoff);
  }
  return false;
}

/**
 * 跨标签串行化的写事务：
 * 加锁 → 从 localStorage 重读最新数据 → 计算变更 → 单次 setItem 原子写入 → 释放锁。
 */
async function withLock<T>(
  fn: (latest: InspectionRecord[]) => { result: T; next: InspectionRecord[] | null },
  lockedResult: T
): Promise<T> {
  const locked = await acquireLock();
  if (!locked) {
    // 拿锁失败（其他标签正在写）：不做任何写入，返回调用方指定的失败结果
    return lockedResult;
  }
  try {
    const latest = readLatest();
    const { result, next } = fn(latest);
    if (next !== null && !persist(next)) {
      throw new Error("persist failed");
    }
    return result;
  } finally {
    releaseLock();
  }
}

/* ---------------- 操作人 ---------------- */

export function loadOperator(): string {
  try {
    return localStorage.getItem(OPERATOR_KEY) ?? "";
  } catch {
    return "";
  }
}

/* ---------------- Store ---------------- */

export type GenerateOutcome =
  | { ok: true; created: number; scope: GenerateScope }
  | { ok: false; message: string; duplicates: string[]; scope: GenerateScope };

type InspectionState = {
  records: InspectionRecord[];
  operator: string;
  setOperator: (name: string) => void;
  /** 按区域生成；有任何重复即整单拦截、零写入 */
  generate: (date: string, shift: Shift, areas: string[]) => Promise<GenerateOutcome>;
  changeStatus: (recordId: string, next: StatusEvent["status"], input: StatusChangeInput) => Promise<ChangeResult>;
  remove: (recordId: string) => Promise<void>;
  resetAll: () => Promise<void>;
  /** 其他标签写入后（storage 事件 / 窗口重新可见）从 localStorage 同步 */
  syncFromStorage: () => void;
};

/** 首次加载：无缓存则立即把旧格式种子落盘，保证多个标签首次打开也一致 */
(function seedIfEmpty() {
  if (safeGetItem(STORAGE_KEY) === null) {
    persist(migrateLegacy(LEGACY_SEED));
  }
})();

export const useInspectionStore = create<InspectionState>((set, get) => ({
  records: readLatest(),
  operator: loadOperator(),

  setOperator: (name) => {
    const trimmed = name.trim();
    try {
      localStorage.setItem(OPERATOR_KEY, trimmed);
    } catch {
      // ignore
    }
    set({ operator: trimmed });
  },

  generate: (date, shift, areas) => {
    const scope: GenerateScope = { date, shift, areas: [...areas] };
    return withLock<GenerateOutcome>(
      (latest) => {
        // 判定一律以锁内重读的最新存储数据为准，绝不使用标签打开时的旧列表
        const plan = planGenerate(latest, date, shift, areas);

        // 整单拦截：任何一个设备已存在 → 全部不写入，重复项与拦截判定同源
        if (plan.duplicates.length > 0) {
          return {
            result: {
              ok: false,
              message: `所选区域有 ${plan.duplicates.length} 项已在该班次生成，本次未写入任何记录，请调整后重试。`,
              duplicates: plan.duplicates,
              scope,
            },
            next: null,
          };
        }
        if (plan.creates.length === 0) {
          return {
            result: {
              ok: false,
              message: "没有可生成的巡检项（请至少选择一个区域）。",
              duplicates: [],
              scope,
            },
            next: null,
          };
        }

        // 单次 setItem 写入整批记录：要么全写，要么不写
        const created: InspectionRecord[] = plan.creates.map((c) => ({
          id: uid(),
          date: c.date,
          shift: c.shift,
          area: c.area,
          device: c.device,
          statusEvents: [],
        }));

        return {
          result: { ok: true, created: created.length, scope },
          next: [...created, ...latest],
        };
      },
      {
        ok: false,
        message: "其他标签正在写入，请稍后重试（本次未写入任何记录）。",
        duplicates: [],
        scope,
      }
    ).then((outcome) => {
      // 成功或被拦截，都以存储为准刷新内存，保证本标签马上看到最新结果
      set({ records: readLatest() });
      return outcome;
    });
  },

  changeStatus: (recordId, nextStatus, input) => {
    return withLock<ChangeResult>(
      (latest) => {
        const record = latest.find((r) => r.id === recordId);
        if (!record) return { result: { ok: false, message: "记录不存在（可能已被其他标签删除）。" }, next: null };

        const current = currentStatus(record);
        if (!nextStatuses(current).includes(nextStatus)) {
          return {
            result: {
              ok: false,
              message:
                current === "normal"
                  ? "正常为关闭状态，不能再变更（不能回到未检）。"
                  : "当前状态不允许该变更。",
            },
            next: null,
          };
        }

        const check = validateChange(current, nextStatus, input);
        if (!check.ok) return { result: check, next: null };

        const event: StatusEvent = {
          id: uid(),
          status: nextStatus,
          at: new Date().toISOString(),
          operator: input.operator.trim(),
          reason: input.reason.trim(),
          ...(nextStatus === "abnormal"
            ? {
                foundAt: input.foundAt!.trim(),
                handler: input.handler!.trim(),
                rectification: input.rectification!.trim(),
              }
            : {}),
        };

        const updated = latest.map((r) =>
          r.id === recordId ? { ...r, statusEvents: [...r.statusEvents, event] } : r
        );
        return { result: { ok: true }, next: updated };
      },
      { ok: false, message: "其他标签正在写入，请稍后重试。" }
    ).then(
      (result) => {
        set({ records: readLatest() });
        return result;
      },
      () => {
        // 持久化失败：内存不做乐观更新，返回失败
        set({ records: readLatest() });
        return { ok: false, message: "保存失败（浏览器存储不可用），本次未写入，请重试。" } satisfies ChangeResult;
      }
    );
  },

  remove: (recordId) => {
    return withLock<{ ok: true } | { ok: false; message: string }>(
      (latest) => ({
        result: { ok: true },
        next: latest.filter((r) => r.id !== recordId),
      }),
      { ok: false, message: "其他标签正在写入，请稍后重试。" }
    ).then(
      () => {
        set({ records: readLatest() });
      },
      () => {
        set({ records: readLatest() });
      }
    );
  },

  resetAll: () => {
    return withLock<{ ok: true }>(
      () => ({
        result: { ok: true },
        next: migrateLegacy(LEGACY_SEED),
      }),
      { ok: true }
    ).then(() => {
      set({ records: readLatest() });
    });
  },

  syncFromStorage: () => {
    set({ records: readLatest() });
  },
}));

/* 其他标签写入时（storage 事件只在“其他”上下文修改时触发）实时同步；
   锁变化时也唤醒，使等待中的生成更快重试。 */
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      useInspectionStore.getState().syncFromStorage();
    }
  });
}
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) useInspectionStore.getState().syncFromStorage();
  });
}

export { STORAGE_KEY, LOCK_KEY, FORMAT_VERSION };
