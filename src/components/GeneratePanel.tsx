import {
  useMemo,
  useState,
} from "react";
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
  SHIFT_LABEL,
  SHIFT_TIME,
  Shift,
  planGenerate,
  today,
} from "../domain";
import { useInspectionStore } from "../store";

const { Text } = Typography;

type GenForm = {
  date: dayjs.Dayjs;
  shift: Shift;
  areas: string[];
};

/** 按区域一次生成当天（某日某班次）巡检项；重复设备提示并拦截 */
export default function GeneratePanel() {
  const records = useInspectionStore((s) => s.records);
  const generate = useInspectionStore((s) => s.generate);
  const [form] = Form.useForm<GenForm>();
  const [duplicates, setDuplicates] = useState<string[]>([]);

  const date = Form.useWatch("date", form) ?? dayjs();
  const shift = Form.useWatch("shift", form) ?? "morning";
  const selectedAreas = Form.useWatch("areas", form) ?? AREAS;

  const preview = useMemo(
    () => planGenerate(records, date.format("YYYY-MM-DD"), shift, selectedAreas),
    [records, date, shift, selectedAreas]
  );

  function run() {
    form
      .validateFields()
      .then((values) => {
        const outcome = generate(
          values.date.format("YYYY-MM-DD"),
          values.shift,
          values.areas
        );
        if (!outcome.ok) {
          setDuplicates(outcome.duplicates);
          message.warning(outcome.message);
          return;
        }
        setDuplicates(outcome.duplicates);
        const dupTip =
          outcome.duplicates.length > 0
            ? `，已自动跳过 ${outcome.duplicates.length} 个重复项`
            : "";
        message.success(
          `已生成 ${outcome.created} 项巡检（${values.date.format(
            "YYYY-MM-DD"
          )} ${SHIFT_LABEL[values.shift]}）${dupTip}`
        );
      })
      .catch(() => {
        message.warning("请先选择巡检日期、班次和至少一个区域。");
      });
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
            <Tag color="orange">重复跳过 {preview.duplicates.length}</Tag>
          </Space>
          <Text type="secondary" className="gen-hint">
            同一设备在同一班次重复生成会被自动拦截。
          </Text>
        </div>

        {duplicates.length > 0 && (
          <Alert
            className="dup-alert"
            type="warning"
            showIcon
            message={`以下设备在 ${date.format("YYYY-MM-DD")} ${
              SHIFT_LABEL[shift]
            } 已存在，未重复生成：`}
            description={duplicates.map((d) => (
              <div key={d}>· {d}</div>
            ))}
          />
        )}

        <Button type="primary" block size="large" onClick={run}>
          生成巡检项
        </Button>
      </Form>
    </Card>
  );
}
