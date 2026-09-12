import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Form,
  Radio,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import dayjs from "dayjs";
import {
  AREAS,
  AREA_CATALOG,
  GenerateScope,
  SHIFT_LABEL,
  SHIFT_TIME,
  Shift,
  planGenerate,
  sameScope,
  today,
} from "../domain";
import { useInspectionStore } from "../store";

const { Text } = Typography;

type GenForm = {
  date: dayjs.Dayjs;
  shift: Shift;
  areas: string[];
};

function scopeOf(values: GenForm): GenerateScope {
  return {
    date: values.date.format("YYYY-MM-DD"),
    shift: values.shift,
    areas: [...values.areas],
  };
}

/** 按区域一次生成当天（某日某班次）巡检项；重复设备整单拦截并提示 */
export default function GeneratePanel() {
  const records = useInspectionStore((s) => s.records);
  const generate = useInspectionStore((s) => s.generate);
  const [form] = Form.useForm<GenForm>();
  const [submitting, setSubmitting] = useState(false);
  // 重复告警及其触发条件快照；只对该日期+班次+区域组合有效
  const [dupAlert, setDupAlert] = useState<{ scope: GenerateScope; items: string[] } | null>(null);

  const date = Form.useWatch("date", form) ?? dayjs();
  const shift = Form.useWatch("shift", form) ?? "morning";
  const selectedAreas = Form.useWatch("areas", form) ?? AREAS;
  const liveScope: GenerateScope = {
    date: date.format("YYYY-MM-DD"),
    shift,
    areas: selectedAreas,
  };

  const preview = useMemo(
    () => planGenerate(records, liveScope.date, liveScope.shift, liveScope.areas),
    [records, liveScope.date, liveScope.shift, liveScope.areas]
  );

  // 表单条件变化 → 旧告警立即失效（不依赖下次点击）
  useEffect(() => {
    if (dupAlert && !sameScope(dupAlert.scope, liveScope)) {
      setDupAlert(null);
    }
  }, [liveScope, dupAlert]);

  async function run() {
    let values: GenForm;
    try {
      values = await form.validateFields();
    } catch {
      message.warning("请先选择巡检日期、班次和至少一个区域。");
      return;
    }
    setSubmitting(true);
    try {
      // 判定以点击时存储中的最新数据为准（store 内加锁后重读），不使用面板预览的旧列表
      const outcome = await generate(
        values.date.format("YYYY-MM-DD"),
        values.shift,
        values.areas
      );
      const scope = scopeOf(values);
      if (!outcome.ok) {
        if (outcome.duplicates.length > 0) {
          // 重复拦截：提示只对本次触发条件生效，与拦截同源
          setDupAlert({ scope, items: outcome.duplicates });
          message.warning(outcome.message);
        } else {
          // 拿不到锁 / 存储失败：不显示成重复，明确失败，原数据未改动，可重试
          setDupAlert(null);
          message.error(outcome.message);
        }
        return;
      }
      setDupAlert(null);
      message.success(
        `已生成 ${outcome.created} 项巡检（${scope.date} ${SHIFT_LABEL[scope.shift]}）。`
      );
    } catch {
      // 兜底：发生任何意外都不能假成功
      setDupAlert(null);
      message.error("生成失败，数据未改动，请重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      className="panel"
      title="当班巡检生成"
      extra={<Tag color="blue">按区域一次生成</Tag>}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ date: dayjs(today()), shift: "morning", areas: [...AREAS] }}
      >
        <Form.Item
          label="巡检日期"
          name="date"
          rules={[{ required: true, message: "请选择巡检日期" }]}
        >
          <DatePicker allowClear={false} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          label="班次"
          name="shift"
          rules={[{ required: true, message: "请选择班次" }]}
        >
          <Radio.Group buttonStyle="solid">
            {(Object.keys(SHIFT_LABEL) as Shift[]).map((s) => (
              <Radio.Button key={s} value={s}>
                {SHIFT_LABEL[s]}
                <span className="shift-time"> {SHIFT_TIME[s]}</span>
              </Radio.Button>
            ))}
          </Radio.Group>
        </Form.Item>

        <Form.Item
          label="区域"
          name="areas"
          rules={[
            {
              validator: (_, value: string[]) =>
                value?.length
                  ? Promise.resolve()
                  : Promise.reject(new Error("至少选择一个区域")),
            },
          ]}
        >
          <Checkbox.Group className="area-checks">
            {AREAS.map((area) => (
              <Checkbox key={area} value={area}>
                {area}
                <Text type="secondary" className="area-count">
                  {" "}
                  {AREA_CATALOG[area].length} 台
                </Text>
              </Checkbox>
            ))}
          </Checkbox.Group>
        </Form.Item>

        <div className="gen-summary">
          <Space size={[8, 8]} wrap>
            <Tag>待生成 {preview.creates.length}</Tag>
            <Tag color="orange">已存在 {preview.duplicates.length}</Tag>
          </Space>
          <Text type="secondary" className="gen-hint">
            同一设备在同一班次已存在时，本次生成将整单拦截、不写入任何记录。
          </Text>
        </div>

        {dupAlert && sameScope(dupAlert.scope, liveScope) && (
          <Alert
            className="dup-alert"
            type="warning"
            showIcon
            message={`${dupAlert.scope.date} ${
              SHIFT_LABEL[dupAlert.scope.shift]
            } 以下设备已存在，本次未写入任何记录：`}
            description={dupAlert.items.map((d) => (
              <div key={d}>· {d}</div>
            ))}
          />
        )}

        <Button type="primary" block size="large" loading={submitting} onClick={run}>
          生成巡检项
        </Button>
      </Form>
    </Card>
  );
}
