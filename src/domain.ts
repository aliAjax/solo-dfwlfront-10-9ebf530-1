import dayjs from "dayjs";

/** 当班巡检状态：三态完全由 statusEvents 驱动，记录上不存“当前状态”字段 */
export type InspectionStatus = "pending" | "normal" | "abnormal";

export const STATUS_LABEL: Record<InspectionStatus, string> = {
  pending: "未检",
  normal: "正常",
  abnormal: "异常",
};

/** 班次 */
export type Shift = "morning" | "afternoon" | "night";

export const SHIFT_LABEL: Record<Shift, string> = {
  morning: "早班",
  afternoon: "中班",
  night: "夜班",
};

export const SHIFT_TIME: Record<Shift, string> = {
  morning: "08:00–16:00",
  afternoon: "16:00–00:00",
  night: "00:00–08:00",
};

/** 一次状态变更的完整留痕 */
export type StatusEvent = {
  id: string;
  /** 变更后状态 */
  status: InspectionStatus;
  /** 变更时间（ISO） */
  at: string;
  /** 操作人 */
  operator: string;
  /** 变更原因 */
  reason: string;
  /** 异常：发现时间（YYYY-MM-DD HH:mm） */
  foundAt?: string;
  /** 异常：处理人 */
  handler?: string;
  /** 异常：整改说明 */
  rectification?: string;
};

/** 一条巡检项记录：同设备同班次同日期唯一 */
export type InspectionRecord = {
  id: string;
  /** 巡检日期 YYYY-MM-DD */
  date: string;
  shift: Shift;
  /** 区域 */
  area: string;
  /** 设备名称（巡检项） */
  device: string;
  /** 操作历史，按时间顺序，最后一条决定当前状态；空数组 = 未检 */
  statusEvents: StatusEvent[];
};

export type StatusChangeInput = {
  operator: string;
  reason: string;
  foundAt?: string;
  handler?: string;
  rectification?: string;
};

export type Filters = {
  area: string;
  status: InspectionStatus | "all";
  /** YYYY-MM-DD 或空字符串（全部日期） */
  date: string;
  keyword: string;
};

/** 区域 -> 当班需巡检的设备清单 */
export const AREA_CATALOG: Record<string, string[]> = {
  加油区: [
    "加油机1号",
    "加油机2号",
    "加油机3号",
    "加油胶管与油枪",
    "紧急切断按钮",
    "静电接地装置",
  ],
  油罐区: [
    "人孔井液位仪",
    "卸油口密封",
    "通气管阻火器",
    "防渗漏监测井",
    "量油孔与阀门",
  ],
  收银区: [
    "收银台监控",
    "消防器材柜",
    "配电柜与线路",
    "应急照明",
    "POS与发票机",
  ],
};

export const AREAS = Object.keys(AREA_CATALOG);
export const ALL_AREA = "全部区域";

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function today(): string {
  return dayjs().format("YYYY-MM-DD");
}

/** 三态由记录驱动：最后一条状态事件决定当前状态，无事件 = 未检 */
export function currentStatus(record: InspectionRecord): InspectionStatus {
  const events = record.statusEvents;
  return events.length > 0 ? events[events.length - 1].status : "pending";
}

/** 同一设备同一班次（同日期）的唯一键 */
export function deviceKey(date: string, shift: Shift, device: string): string {
  return `${date}__${shift}__${device.trim()}`;
}

/** 合法状态流转：未检 → 正常/异常；异常 → 正常（关闭整改）；正常为终态，不能回到未检 */
export function nextStatuses(status: InspectionStatus): InspectionStatus[] {
  if (status === "pending") return ["normal", "abnormal"];
  if (status === "abnormal") return ["normal"];
  return [];
}

export type ChangeError =
  | { ok: true }
  | { ok: false; message: string };

export function validateChange(
  status: InspectionStatus,
  next: InspectionStatus,
  input: StatusChangeInput
): ChangeError {
  if (status === "normal") {
    return { ok: false, message: "正常为关闭状态，不能再变更（不能回到未检）。" };
  }
  if (status === "abnormal" && next !== "normal") {
    return { ok: false, message: "异常只能整改后关闭为正常。" };
  }
  if (status === "pending" && next === "pending") {
    return { ok: false, message: "未检不能登记为未检。" };
  }
  if (!input.operator.trim()) {
    return { ok: false, message: "请填写操作人。" };
  }
  if (!input.reason.trim()) {
    return { ok: false, message: "请填写变更原因。" };
  }
  // 异常必须填写发现时间、处理人、整改说明，信息不全不能提交
  if (next === "abnormal") {
    if (!input.foundAt?.trim()) return { ok: false, message: "异常登记必须填写发现时间。" };
    if (!input.handler?.trim()) return { ok: false, message: "异常登记必须填写处理人。" };
    if (!input.rectification?.trim()) return { ok: false, message: "异常登记必须填写整改说明。" };
  }
  return { ok: true };
}

export type GeneratePlan = {
  creates: Array<{ date: string; shift: Shift; area: string; device: string }>;
  duplicates: string[];
};

/** 一次生成动作的条件快照：重复告警只对该日期+班次+区域组合有效 */
export type GenerateScope = {
  date: string;
  shift: Shift;
  areas: string[];
};

/** 条件是否相同（区域集合相同即可，与勾选顺序无关）；条件一变旧告警立即失效 */
export function sameScope(a: GenerateScope, b: GenerateScope): boolean {
  if (a.date !== b.date || a.shift !== b.shift) return false;
  if (a.areas.length !== b.areas.length) return false;
  const setB = new Set(b.areas);
  return a.areas.every((area) => setB.has(area));
}

/**
 * 按区域一次生成某天某班次的巡检项；
 * 同设备同班次已存在则拦截（跳过并列出），不做覆盖。
 */
export function planGenerate(
  records: InspectionRecord[],
  date: string,
  shift: Shift,
  areas: string[]
): GeneratePlan {
  const existing = new Set(
    records.map((r) => deviceKey(r.date, r.shift, r.device))
  );
  const creates: GeneratePlan["creates"] = [];
  const duplicates: string[] = [];
  for (const area of areas) {
    for (const device of AREA_CATALOG[area] ?? []) {
      if (existing.has(deviceKey(date, shift, device))) {
        duplicates.push(`${area} / ${device}`);
      } else {
        creates.push({ date, shift, area, device });
      }
    }
  }
  return { creates, duplicates };
}

export function applyFilters(records: InspectionRecord[], filters: Filters): InspectionRecord[] {
  const keyword = filters.keyword.trim().toLowerCase();
  return records.filter((r) => {
    if (filters.area !== ALL_AREA && r.area !== filters.area) return false;
    if (filters.status !== "all" && currentStatus(r) !== filters.status) return false;
    if (filters.date && r.date !== filters.date) return false;
    if (keyword) {
      const haystack = [
        r.device,
        r.area,
        SHIFT_LABEL[r.shift],
        ...r.statusEvents.flatMap((e) => [
          e.operator,
          e.reason,
          e.handler ?? "",
          e.rectification ?? "",
        ]),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

export type Stats = {
  total: number;
  pending: number;
  normal: number;
  abnormal: number;
  checked: number;
  completion: number;
};

/** 统计始终基于传入（筛选后）的记录集合 */
export function computeStats(rows: InspectionRecord[]): Stats {
  const total = rows.length;
  let pending = 0;
  let normal = 0;
  let abnormal = 0;
  for (const r of rows) {
    const s = currentStatus(r);
    if (s === "pending") pending += 1;
    else if (s === "normal") normal += 1;
    else abnormal += 1;
  }
  const checked = normal + abnormal;
  return {
    total,
    pending,
    normal,
    abnormal,
    checked,
    completion: total === 0 ? 0 : Math.round((checked / total) * 100),
  };
}

/** 旧版本（dfwlfront-10-inspection v1）记录结构 */
type LegacyRecord = {
  id?: unknown;
  item?: unknown;
  area?: unknown;
  inspector?: unknown;
  checkedAt?: unknown;
  status?: unknown;
  notes?: unknown;
  createdAt?: unknown;
};

/**
 * 迁移旧格式记录：扁平数组 -> 记录驱动的状态事件模型。
 * 旧数据缺班次信息，统一归入早班；缺发现时间的异常保留为空（界面显示“—”）。
 */
export function migrateLegacy(raw: LegacyRecord[]): InspectionRecord[] {
  return raw.map((rec, index) => {
    // 旧数据中可能混入 null / 非对象条目，按空记录兜底，保证整批仍可读取
    const r: LegacyRecord = rec && typeof rec === "object" ? rec : {};
    const device = typeof r.item === "string" && r.item.trim() ? r.item : `未命名设备${index + 1}`;
    const area = AREAS.includes(r.area as string) ? (r.area as string) : "加油区";
    const operator =
      typeof r.inspector === "string" && r.inspector.trim() ? r.inspector : "历史数据";
    const date =
      typeof r.checkedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.checkedAt)
        ? r.checkedAt
        : "2026-06-30";
    const at =
      typeof r.createdAt === "string" && r.createdAt
        ? r.createdAt
        : dayjs(`${date} 09:00`).toISOString();
    const reason = typeof r.notes === "string" && r.notes.trim() ? r.notes : "历史数据迁移";
    const status: InspectionStatus =
      r.status === "异常" ? "abnormal" : r.status === "正常" ? "normal" : "pending";

    const events: StatusEvent[] =
      status === "pending"
        ? []
        : [
            {
              id: `legacy-event-${index}`,
              status,
              at,
              operator,
              reason,
              ...(status === "abnormal"
                ? { foundAt: "", handler: operator, rectification: reason }
                : {}),
            },
          ];

    return {
      id: typeof r.id === "string" && r.id ? r.id : `seed-${index + 1}`,
      date,
      shift: "morning",
      area,
      device,
      statusEvents: events,
    };
  });
}

/** 首次进入的种子数据，刻意保留为旧格式，用于演示“旧格式记录仍能读取” */
export const LEGACY_SEED: LegacyRecord[] = [
  {
    item: "加油机1号",
    area: "加油区",
    inspector: "何鑫",
    checkedAt: "2026-06-30",
    status: "正常",
    notes: "无异常",
  },
  {
    item: "卸油口密封",
    area: "油罐区",
    inspector: "何鑫",
    checkedAt: "2026-06-30",
    status: "异常",
    notes: "密封圈老化，已登记待更换",
  },
];
