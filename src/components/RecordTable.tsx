import { useMemo } from "react";
import { Button, Empty, Popconfirm, Space, Table, Tag, Timeline, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import {
  InspectionRecord,
  InspectionStatus,
  SHIFT_LABEL,
  STATUS_LABEL,
  currentStatus,
  nextStatuses,
} from "../domain";

const { Text } = Typography;

const STATUS_TAG: Record<InspectionStatus, { color: string; className: string }> = {
  pending: { color: "default", className: "st-pending" },
  normal: { color: "success", className: "st-normal" },
  abnormal: { color: "error", className: "st-abnormal" },
};

type Props = {
  rows: InspectionRecord[];
  onChange: (record: InspectionRecord, target: InspectionStatus) => void;
  onRemove: (recordId: string) => void;
};

function formatAt(iso: string) {
  const d = dayjs(iso);
  return d.isValid() ? d.format("YYYY-MM-DD HH:mm:ss") : iso;
}

function EventsTimeline({ record }: { record: InspectionRecord }) {
  if (record.statusEvents.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="暂无状态记录，等待当班巡检（当前为未检）"
        className="inner-empty"
      />
    );
  }
  return (
    <Timeline
      items={record.statusEvents.map((e) => ({
        color: e.status === "abnormal" ? "red" : e.status === "normal" ? "green" : "gray",
        children: (
          <div className="event-item">
            <Space size={8} wrap>
              <Tag color={STATUS_TAG[e.status].color}>{STATUS_LABEL[e.status]}</Tag>
              <Text strong>{formatAt(e.at)}</Text>
              <Text type="secondary">操作人：{e.operator}</Text>
            </Space>
            <div className="event-reason">原因：{e.reason}</div>
            {e.status === "abnormal" && (
              <div className="event-abnormal">
                <div>发现时间：{e.foundAt || "—（历史数据未记录）"}</div>
                <div>处理人：{e.handler || "—"}</div>
                <div>整改说明：{e.rectification || "—"}</div>
              </div>
            )}
            {e.status === "normal" &&
              record.statusEvents.some(
                (prev) => prev.status === "abnormal" && prev.at <= e.at
              ) && <div className="event-close">已整改关闭</div>}
          </div>
        ),
      }))}
    />
  );
}

/** 巡检记录表：当前状态由状态事件驱动，正常为终态只能查看，异常可整改关闭 */
export default function RecordTable({ rows, onChange, onRemove }: Props) {
  const columns = useMemo<ColumnsType<InspectionRecord>>(
    () => [
      {
        title: "设备 / 巡检项",
        dataIndex: "device",
        key: "device",
        width: 190,
        render: (device: string) => <Text strong>{device}</Text>,
      },
      { title: "区域", dataIndex: "area", key: "area", width: 100 },
      {
        title: "日期 / 班次",
        key: "when",
        width: 150,
        render: (_, r) => (
          <div>
            <div>{r.date}</div>
            <Text type="secondary">{SHIFT_LABEL[r.shift]}</Text>
          </div>
        ),
      },
      {
        title: "当前状态",
        key: "status",
        width: 100,
        render: (_, r) => {
          const s = currentStatus(r);
          return (
            <Tag className={STATUS_TAG[s].className} color={STATUS_TAG[s].color}>
              {STATUS_LABEL[s]}
            </Tag>
          );
        },
      },
      {
        title: "最近操作",
        key: "last",
        render: (_, r) => {
          const last = r.statusEvents.length > 0 ? r.statusEvents[r.statusEvents.length - 1] : undefined;
          if (!last) return <Text type="secondary">尚未巡检</Text>;
          return (
            <div>
              <Text type="secondary">{formatAt(last.at)}</Text>
              <div className="last-operator">
                {last.operator} · {last.reason}
              </div>
            </div>
          );
        },
      },
      {
        title: "操作",
        key: "actions",
        width: 210,
        render: (_, r) => {
          const s = currentStatus(r);
          const allowed = nextStatuses(s);
          return (
            <Space size={8} wrap>
              {allowed.map((next) => (
                <Button
                  key={next}
                  size="small"
                  type={next === "abnormal" ? "primary" : "default"}
                  danger={next === "abnormal"}
                  onClick={() => onChange(r, next)}
                >
                  {next === "abnormal" ? "登记异常" : s === "abnormal" ? "整改关闭" : "登记正常"}
                </Button>
              ))}
              {s === "normal" && (
                <Tooltip title="正常为关闭状态，不能回到未检">
                  <Button size="small" disabled>
                    已关闭
                  </Button>
                </Tooltip>
              )}
              {s === "abnormal" && (
                <Tooltip title="异常需填写处理人和整改说明后关闭为正常">
                  <Button size="small" disabled>
                    待整改
                  </Button>
                </Tooltip>
              )}
              <Popconfirm
                title="删除该巡检记录？"
                description="状态历史将一并删除，且不可恢复。"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => onRemove(r.id)}
              >
                <Button size="small" type="text" danger>
                  删除
                </Button>
              </Popconfirm>
            </Space>
          );
        },
      },
    ],
    [onChange, onRemove]
  );

  return (
    <Table<InspectionRecord>
      rowKey="id"
      columns={columns}
      dataSource={rows}
      size="middle"
      pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (n) => `共 ${n} 条` }}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span>
                没有符合筛选条件的巡检记录
                <br />
                <Text type="secondary">调整筛选条件，或在左侧按区域生成当班巡检项</Text>
              </span>
            }
          />
        ),
      }}
      expandable={{
        expandedRowRender: (r) => <EventsTimeline record={r} />,
        rowExpandable: (r) => true,
      }}
    />
  );
}
