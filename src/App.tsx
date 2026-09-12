import { FormEvent, useMemo, useState } from "react";

type Field = {
  key: string;
  label: string;
  type?: "number" | "date" | "select";
  options?: string[];
};

type RecordItem = {
  id: string;
  status: string;
  notes: string;
  createdAt: string;
  [key: string]: string | number;
};

const project = {
  "number": 10,
  "folder": "dfwl/frontend/dfwlfront-10",
  "framework": "react",
  "title": "油站设备巡检清单",
  "subtitle": "创建巡检项、标记异常，并统计今日巡检状态。",
  "industry": "石油",
  "stack": [
    "React",
    "Vite",
    "TypeScript",
    "Zustand",
    "Ant Design"
  ],
  "storageKey": "dfwlfront-10-inspection",
  "formTitle": "新增巡检项",
  "primaryAction": "加入清单",
  "entityLabel": "巡检项",
  "statuses": [
    "未检",
    "正常",
    "异常"
  ],
  "filters": [
    "全部区域",
    "加油区",
    "油罐区",
    "收银区"
  ],
  "fields": [
    {
      "key": "item",
      "label": "巡检项"
    },
    {
      "key": "area",
      "label": "区域",
      "type": "select",
      "options": [
        "加油区",
        "油罐区",
        "收银区"
      ]
    },
    {
      "key": "inspector",
      "label": "巡检人"
    },
    {
      "key": "checkedAt",
      "label": "巡检日期",
      "type": "date"
    }
  ],
  "records": [
    {
      "item": "加油机1号",
      "area": "加油区",
      "inspector": "何鑫",
      "checkedAt": "2026-06-30",
      "status": "正常",
      "notes": "无异常"
    },
    {
      "item": "卸油口密封",
      "area": "油罐区",
      "inspector": "何鑫",
      "checkedAt": "2026-06-30",
      "status": "异常",
      "notes": "密封圈老化"
    }
  ],
  "metricLabels": [
    "巡检项",
    "异常",
    "已检"
  ]
} as const;

const fields = project.fields as unknown as Field[];
const statuses: string[] = [...project.statuses];

function createBlank() {
  return Object.fromEntries(fields.map((field) => [field.key, field.type === "number" ? 0 : ""]));
}

function loadRecords(): RecordItem[] {
  const raw = localStorage.getItem(project.storageKey);
  if (!raw) {
    return project.records.map((record, index) => ({
      ...record,
      id: `seed-${index + 1}`,
      createdAt: new Date(Date.now() - index * 86400000).toISOString()
    })) as RecordItem[];
  }
  try {
    return JSON.parse(raw) as RecordItem[];
  } catch {
    return [];
  }
}

function saveRecords(records: RecordItem[]) {
  localStorage.setItem(project.storageKey, JSON.stringify(records));
}

function nextStatus(status: string) {
  const index = statuses.indexOf(status);
  return statuses[(index + 1) % statuses.length];
}

function primaryText(record: RecordItem) {
  const first = fields[0];
  const second = fields[1];
  return [record[first.key], record[second.key]].filter(Boolean).join(" / ") || project.entityLabel;
}

export default function App() {
  const [records, setRecords] = useState<RecordItem[]>(loadRecords);
  const [form, setForm] = useState<Record<string, string | number>>(createBlank);
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState<string>(project.filters[0]);

  const filteredRecords = useMemo(() => {
    if (filter.startsWith("全部")) return records;
    return records.filter((record) => Object.values(record).includes(filter));
  }, [filter, records]);

  const metrics = useMemo(() => {
    const total = records.length;
    const second = records.filter((record) => record.status === statuses[1]).length;
    const third = records.filter((record) => record.status === statuses[2]).length;
    const numberValues = records.flatMap((record) =>
      fields.filter((field) => field.type === "number").map((field) => Number(record[field.key] || 0))
    );
    const sum = numberValues.reduce((acc, value) => acc + value, 0);
    return [total, second || sum, third || Math.round(sum / Math.max(total, 1))];
  }, [records]);

  const chartRows = statuses.map((status) => ({
    status,
    value: records.filter((record) => record.status === status).length
  }));
  const maxChart = Math.max(1, ...chartRows.map((row) => row.value));

  function updateRecords(next: RecordItem[]) {
    setRecords(next);
    saveRecords(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: RecordItem = {
      ...form,
      id: crypto.randomUUID(),
      status: statuses[0],
      notes: note || "暂无备注",
      createdAt: new Date().toISOString()
    } as RecordItem;
    updateRecords([next, ...records]);
    setForm(createBlank());
    setNote("");
  }

  return (
    <main className="app">
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">{project.industry}行业前端最小闭环</p>
            <h1>{project.title}</h1>
            <p className="subtitle">{project.subtitle}</p>
          </div>
          <div className="stack">{project.stack.map((item) => <span className="tag" key={item}>{item}</span>)}</div>
        </header>

        <section className="metrics">
          {project.metricLabels.map((label, index) => (
            <article className="metric" key={label}>
              <span>{label}</span>
              <strong>{metrics[index]}</strong>
            </article>
          ))}
        </section>

        <section className="workspace">
          <form className="panel" onSubmit={handleSubmit}>
            <h2>{project.formTitle}</h2>
            <div className="form-grid">
              {fields.map((field) => (
                <label key={field.key}>
                  {field.label}
                  {field.type === "select" ? (
                    <select
                      value={String(form[field.key])}
                      onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
                      required
                    >
                      <option value="">请选择</option>
                      {field.options?.map((option) => <option key={option}>{option}</option>)}
                    </select>
                  ) : (
                    <input
                      type={field.type || "text"}
                      value={form[field.key]}
                      onChange={(event) =>
                        setForm({ ...form, [field.key]: field.type === "number" ? Number(event.target.value) : event.target.value })
                      }
                      required
                    />
                  )}
                </label>
              ))}
              <label>
                备注
                <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="填写处理说明或现场备注" />
              </label>
              <button type="submit">{project.primaryAction}</button>
            </div>
          </form>

          <section className="list-panel">
            <div className="toolbar">
              <h2>{project.entityLabel}列表</h2>
              <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                {project.filters.map((item) => <option key={item}>{item}</option>)}
              </select>
            </div>

            <div className="record-grid">
              {filteredRecords.length === 0 ? <div className="empty">暂无匹配数据</div> : filteredRecords.map((record) => (
                <article className="record" key={record.id}>
                  <div className="record-head">
                    <p className="record-title">{primaryText(record)}</p>
                    <span className="status">{record.status}</span>
                  </div>
                  <div className="details">
                    {fields.map((field) => (
                      <span key={field.key}>{field.label}: {record[field.key]}</span>
                    ))}
                  </div>
                  <p className="note">{record.notes}</p>
                  <div className="actions">
                    <button type="button" onClick={() => updateRecords(records.map((item) => item.id === record.id ? { ...item, status: nextStatus(item.status) } : item))}>
                      流转状态
                    </button>
                    <button className="secondary" type="button" onClick={() => navigator.clipboard?.writeText(primaryText(record))}>
                      复制摘要
                    </button>
                    <button className="danger" type="button" onClick={() => updateRecords(records.filter((item) => item.id !== record.id))}>
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <div className="mini-chart">
              {chartRows.map((row) => (
                <div className="bar" key={row.status}>
                  <span>{row.status}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${(row.value / maxChart) * 100}%` }} /></div>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
