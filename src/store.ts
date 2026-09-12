import { create } from "zustand";
import {
  InspectionRecord,
  LEGACY_SEED,
  Shift,
  StatusChangeInput,
  StatusEvent,
  currentStatus,
  deviceKey,
  migrateLegacy,
  nextStatuses,
  planGenerate,
  uid,
  validateChange,
} from "./domain";

const STORAGE_KEY = "dfwlfront-10-inspection";
const OPERATOR_KEY = "dfwlfront-10-operator";
const FORMAT_VERSION = 2;

type PersistedShape = {
  version: typeof FORMAT_VERSION;
  records: InspectionRecord[];
};

export type ChangeResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * 读取持久化数据：
 * - 无数据：播种旧格式种子（首次进入）
 * - 旧版（扁平数组）：迁移为新模型，继续以新格式保存
 * - 新版：校验后返回
 */
export function loadPersisted(): InspectionRecord[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return migrateLegacy(LEGACY_SEED);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return migrateLegacy(LEGACY_SEED);
  }

  // 旧格式：直接是数组
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

function persist(records: InspectionRecord[]) {
  const payload: PersistedShape = { version: FORMAT_VERSION, records };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 存储不可用时仅影响持久化，不阻断当班操作
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

export function loadOperator(): string {
  try {
    return localStorage.getItem(OPERATOR_KEY) ?? "";
  } catch {
    return "";
  }
}

export type GenerateOutcome =
  | { ok: true; created: number; duplicates: string[] }
  | { ok: false; message: string; duplicates: string[] };

type InspectionState = {
  records: InspectionRecord[];
  operator: string;
  setOperator: (name: string) => void;
  generate: (date: string, shift: Shift, areas: string[]) => GenerateOutcome;
  changeStatus: (recordId: string, next: StatusEvent["status"], input: StatusChangeInput) => ChangeResult;
  remove: (recordId: string) => void;
  resetAll: () => void;
};

export const useInspectionStore = create<InspectionState>((set, get) => ({
  records: loadPersisted(),
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
    const { records } = get();
    const plan = planGenerate(records, date, shift, areas);
    if (plan.creates.length === 0) {
      return {
        ok: false,
        message: "所选区域的设备在该班次均已生成过巡检项，请勿重复录入。",
        duplicates: plan.duplicates,
      };
    }
    const created: InspectionRecord[] = plan.creates.map((c) => ({
      id: uid(),
      date: c.date,
      shift: c.shift,
      area: c.area,
      device: c.device,
      statusEvents: [],
    }));
    const next = [...created, ...records];
    persist(next);
    set({ records: next });
    return { ok: true, created: created.length, duplicates: plan.duplicates };
  },

  changeStatus: (recordId, next, input) => {
    const { records } = get();
    const record = records.find((r) => r.id === recordId);
    if (!record) return { ok: false, message: "记录不存在。" };

    const current = currentStatus(record);
    if (!nextStatuses(current).includes(next)) {
      return {
        ok: false,
        message:
          current === "normal"
            ? "正常为关闭状态，不能再变更（不能回到未检）。"
            : "当前状态不允许该变更。",
      };
    }

    const check = validateChange(current, next, input);
    if (!check.ok) return check;

    // 同设备同班次重复录入的二次拦截（状态事件层面不允许并发重复登记）
    const event: StatusEvent = {
      id: uid(),
      status: next,
      at: new Date().toISOString(),
      operator: input.operator.trim(),
      reason: input.reason.trim(),
      ...(next === "abnormal"
        ? {
            foundAt: input.foundAt!.trim(),
            handler: input.handler!.trim(),
            rectification: input.rectification!.trim(),
          }
        : {}),
    };

    const updated = records.map((r) =>
      r.id === recordId ? { ...r, statusEvents: [...r.statusEvents, event] } : r
    );
    persist(updated);
    set({ records: updated });
    return { ok: true };
  },

  remove: (recordId) => {
    const next = get().records.filter((r) => r.id !== recordId);
    persist(next);
    set({ records: next });
  },

  resetAll: () => {
    const seeded = migrateLegacy(LEGACY_SEED);
    persist(seeded);
    set({ records: seeded });
  },
}));

export { STORAGE_KEY, deviceKey };
