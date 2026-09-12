import { useMemo, useState } from "react";
import {
  Button,
  ConfigProvider,
  DatePicker,
  Input,
  Popconfirm,
  Progress,
  Select,
  Space,
  Tag,
  message,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import GeneratePanel from "./components/GeneratePanel";
import RecordTable from "./components/RecordTable";
import StatusModal from "./components/StatusModal";
import {
  ALL_AREA,
  AREAS,
  Filters,
  InspectionRecord,
  InspectionStatus,
  STATUS_LABEL,
  applyFilters,
  computeStats,
  currentStatus,
} from "./domain";
import { useInspectionStore } from "./store";

dayjs.locale("zh-cn");

const STACK = ["React", "Vite", "TypeScript", "Zustand", "Ant Design"];

type ModalState = {
  open: boolean;
  record: InspectionRecord | null;
  target: InspectionStatus;
};

const CLOSED_MODAL: ModalState = { open: false, record: null, target: "normal" };

export default function App() {
  const records = useInspectionStore((s) => s.records);
  const operator = useInspectionStore((s) => s.operator);
  const setOperator = useInspectionStore((s) => s.setOperator);
  const remove = useInspectionStore((s) => s.remove);
  const resetAll = useInspectionStore((s) => s.resetAll);

  const [operatorDraft, setOperatorDraft] = useState(operator);
  const [filters, setFilters] = useState<Filters>({
    area: ALL_AREA,
    status: "all",
    date: "",
    keyword: "",
  });
  const [modal, setModal] = useState<ModalState>(CLOSED_MODAL);

  const filtered = useMemo(() => applyFilters(records, filters), [records, filters]);
  const stats = useMemo(() => computeStats(filtered), [filtered]);
  const maxStatusCount = Math.max(1, stats.pending, stats.normal, stats.abnormal);

  const statusOptions: Array<{ value: Filters["status"]; label: string }> = [
    { value: "all", label: "全部状态" },
    { value: "pending", label: STATUS_LABEL.pending },
    { value: "normal", label: STATUS_LABEL.normal },
    { value: "abnormal", label: STATUS_LABEL.abnormal },
  ];

  function patchFilter(patch: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
  }

  function resetFilters() {
    setFilters({ area: ALL_AREA, status: "all", date: "", keyword: "" });
  }

  function openModal(record: InspectionRecord, target: InspectionStatus) {
    setModal({ open: true, record, target });
  }

  async function handleRemove(id: string) {
    await remove(id);
    message.success("记录已删除");
  }

  const metricCards = [
    { key: "total", label: "巡检项（当前筛选）", value: stats.total, tone: "" },
    { key: "pending", label: "未检", value: stats.pending, tone: "tone-pending" },
    { key: "normal", label: "正常", value: stats.normal, tone: "tone-normal" },
    { key: "abnormal", label: "异常", value: stats.abnormal, tone: "tone-abnormal" },
  ];

  return (
    <ConfigProvider locale={zhCN}>
      <main className="app">
        <div className="shell">
          <header className="topbar">
            <div>
              <p className="eyebrow">石油行业 · 当班巡检闭环</p>
              <h1>油站设备巡检清单</h1>
              <p className="subtitle">
                按区域一次生成当班巡检项，未检 / 正常 / 异常三态由巡检记录驱动；状态变更全程留痕，
                异常整改闭环后方可关闭。
              </p>
            </div>
            <div className="topbar-side">
              <div className="stack">
                {STACK.map((item) => (
                  <span className="tag" key={item}>
                    {item}
                  </span>
                ))}
              </div>
              <Space className="operator-bar">
              <Space.Compact className="operator-bar-input">
                <Button disabled>当班员工</Button>
                <Input
                  placeholder="输入姓名后自动保存"
                  value={operatorDraft}
                  maxLength={20}
                  onChange={(e) => setOperatorDraft(e.target.value)}
                  onBlur={() => setOperator(operatorDraft)}
                  onPressEnter={() => setOperator(operatorDraft)}
                  style={{ width: 180 }}
                />
              </Space.Compact>
                <Popconfirm
                  title="恢复为演示数据？"
                  description="当前所有巡检记录将被清空并重新写入旧格式示例数据。"
                  okText="恢复"
                  cancelText="取消"
                  onConfirm={() => {
                    resetAll();
                    message.success("已恢复演示数据（旧格式）");
                  }}
                >
                  <Button>重置演示数据</Button>
                </Popconfirm>
              </Space>
            </div>
          </header>

          <section className="metrics">
            {metricCards.map((card) => (
              <article className={`metric ${card.tone}`} key={card.key}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
              </article>
            ))}
            <article className="metric metric-progress">
              <span>
                当班完成率（已检 {stats.checked}/{stats.total}）
              </span>
              <Progress percent={stats.completion} status={stats.abnormal > 0 ? "exception" : "active"} />
              <div className="dist-bars">
                {(
                  [
                    ["pending", stats.pending, "#8c8c8c"],
                    ["normal", stats.normal, "#52c41a"],
                    ["abnormal", stats.abnormal, "#ff4d4f"],
                  ] as const
                ).map(([key, value, color]) => (
                  <div className="dist-row" key={key}>
                    <span>{STATUS_LABEL[key]}</span>
                    <div className="dist-track">
                      <div
                        className="dist-fill"
                        style={{ width: `${(value / maxStatusCount) * 100}%`, background: color }}
                      />
                    </div>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="workspace">
            <div className="left-col">
              <GeneratePanel />
            </div>

            <section className="list-panel">
              <div className="toolbar">
                <h2>
                  巡检记录 <Tag>{filtered.length} 条</Tag>
                </h2>
                <Space size={8} wrap className="filters">
                  <Select
                    value={filters.area}
                    onChange={(value) => patchFilter({ area: value })}
                    style={{ width: 120 }}
                    options={[ALL_AREA, ...AREAS].map((a) => ({ value: a, label: a }))}
                  />
                  <Select
                    value={filters.status}
                    onChange={(value) => patchFilter({ status: value })}
                    style={{ width: 120 }}
                    options={statusOptions}
                  />
                  <DatePicker
                    value={filters.date ? dayjs(filters.date) : null}
                    onChange={(d) => patchFilter({ date: d ? d.format("YYYY-MM-DD") : "" })}
                    placeholder="巡检日期（可清空）"
                    allowClear
                    style={{ width: 190 }}
                  />
                  <Input.Search
                    allowClear
                    placeholder="关键字：设备 / 操作人 / 原因 / 整改"
                    value={filters.keyword}
                    onChange={(e) => patchFilter({ keyword: e.target.value })}
                    style={{ width: 260 }}
                  />
                  <Button onClick={resetFilters}>重置筛选</Button>
                </Space>
              </div>

              <RecordTable
                rows={filtered}
                onChange={openModal}
                onRemove={handleRemove}
              />
            </section>
          </section>
        </div>

        {modal.open && modal.record && (
          <StatusModal
            open={modal.open}
            recordId={modal.record.id}
            device={modal.record.device}
            current={currentStatus(modal.record)}
            target={modal.target}
            operator={operator || operatorDraft}
            onClose={() => setModal(CLOSED_MODAL)}
            onSucceeded={() => {
              const wasAbnormal = currentStatus(modal.record!) === "abnormal";
              message.success(
                modal.target === "abnormal"
                  ? "异常已登记"
                  : wasAbnormal
                    ? "异常已整改关闭"
                    : "巡检结果已登记"
              );
            }}
          />
        )}
      </main>
    </ConfigProvider>
  );
}
