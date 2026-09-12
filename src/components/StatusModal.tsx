import { useEffect, useState } from "react";
import { Alert, DatePicker, Form, Input, Modal } from "antd";
import dayjs from "dayjs";
import { InspectionStatus, STATUS_LABEL, StatusChangeInput } from "../domain";
import { useInspectionStore } from "../store";

type Props = {
  open: boolean;
  recordId: string | null;
  device: string;
  current: InspectionStatus;
  /** 本次要登记成的目标状态 */
  target: InspectionStatus;
  operator: string;
  onClose: () => void;
  onSucceeded: () => void;
};

type FormValues = {
  operator: string;
  reason: string;
  foundAt: dayjs.Dayjs;
  handler: string;
  rectification: string;
};

/** 状态变更登记：时间自动记录，操作人与原因必填；异常额外要求发现时间/处理人/整改说明 */
export default function StatusModal({
  open,
  recordId,
  device,
  current,
  target,
  operator,
  onClose,
  onSucceeded,
}: Props) {
  const changeStatus = useInspectionStore((s) => s.changeStatus);
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  // 落盘/锁/记录缺失等可重试错误：顶部提示并保留弹窗；表单校验错误仍显示在字段下
  const [submitError, setSubmitError] = useState("");
  const isAbnormal = target === "abnormal";

  useEffect(() => {
    if (open) {
      setSaving(false);
      setSubmitError("");
      form.setFieldsValue({
        operator,
        reason: "",
        foundAt: dayjs(),
        handler: operator,
        rectification: "",
      });
    }
  }, [open, operator, form]);

  const title =
    target === "abnormal"
      ? "登记异常"
      : current === "abnormal"
        ? "整改关闭（异常 → 正常）"
        : "巡检正常（未检 → 正常）";

  function handleOk() {
    form
      .validateFields()
      .then(async (values) => {
        if (!recordId) return;
        const input: StatusChangeInput = {
          operator: values.operator,
          reason: values.reason,
          ...(isAbnormal
            ? {
                foundAt: values.foundAt.format("YYYY-MM-DD HH:mm"),
                handler: values.handler,
                rectification: values.rectification,
              }
            : {}),
        };
        setSaving(true);
        try {
          // 判定与写入均以 store 锁内重读的最新数据为准
          const result = await changeStatus(recordId, target, input);
          if (!result.ok) {
            // 锁竞争 / 落盘失败 / 记录已被删除：保留弹窗与已填内容，明确失败并允许重试
            setSubmitError(result.message);
            return;
          }
          onSucceeded();
          onClose();
        } catch {
          setSubmitError("提交失败，数据未改动，请重试。");
        } finally {
          setSaving(false);
        }
      })
      .catch(() => {
        // 校验失败时 antd 已在字段下提示，信息不全不能提交
      });
  }

  return (
    <Modal
      open={open}
      title={`${title} · ${device}`}
      okText="提交登记"
      cancelText="取消"
      onOk={handleOk}
      onCancel={onClose}
      destroyOnHidden
      confirmLoading={saving}
      okButtonProps={{ danger: isAbnormal }}
    >
      <Form
        form={form}
        layout="vertical"
        className="status-form"
        onValuesChange={() => setSubmitError("")}
      >
        {submitError && (
          <Alert
            type="error"
            showIcon
            message="本次未保存"
            description={`${submitError} 已填写内容已保留，可直接重试。`}
            style={{ marginBottom: 12 }}
          />
        )}
        <Form.Item
          label="操作人"
          name="operator"
          rules={[{ required: true, whitespace: true, message: "请填写操作人" }]}
        >
          <Input placeholder="当班员工姓名" maxLength={20} />
        </Form.Item>

        <Form.Item
          label={target === "normal" && current === "abnormal" ? "关闭原因" : "巡检情况 / 变更原因"}
          name="reason"
          rules={[{ required: true, whitespace: true, message: "请填写原因" }]}
        >
          <Input.TextArea
            rows={3}
            placeholder={
              target === "normal" && current === "abnormal"
                ? "说明整改与复核结论"
                : "说明巡检情况或变更原因"
            }
            maxLength={200}
            showCount
          />
        </Form.Item>

        {isAbnormal && (
          <>
            <Form.Item
              label="发现时间"
              name="foundAt"
              rules={[{ required: true, message: "请选择异常发现时间" }]}
            >
              <DatePicker showTime={{ format: "HH:mm" }} allowClear={false} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label="处理人"
              name="handler"
              rules={[{ required: true, whitespace: true, message: "异常必须填写处理人" }]}
            >
              <Input placeholder="负责处理该异常的人员" maxLength={20} />
            </Form.Item>
            <Form.Item
              label="整改说明"
              name="rectification"
              rules={[{ required: true, whitespace: true, message: "异常必须填写整改说明" }]}
            >
              <Input.TextArea
                rows={3}
                placeholder="已采取的处置措施与整改安排，填写完整才能提交"
                maxLength={200}
                showCount
              />
            </Form.Item>
          </>
        )}

        <p className="modal-tip">
          变更时间由系统自动记录；状态将从「{STATUS_LABEL[current]}」流转为「
          {STATUS_LABEL[target]}」。正常为关闭状态，提交后不能回到未检。
        </p>
      </Form>
    </Modal>
  );
}
