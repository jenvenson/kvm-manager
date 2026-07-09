import { useEffect, useState } from 'react'
import { Form, InputNumber, Button, message, Alert } from 'antd'
import { cpuApi } from '../api/client'
import type { CPUConfig } from '../types'

export default function CPUPanel({ name, running }: { name: string; running: boolean }) {
  const [form] = Form.useForm<CPUConfig>()
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState<number>(1)

  useEffect(() => {
    cpuApi.get(name).then(d => {
      form.setFieldsValue(d)
      setTotal((d.sockets ?? 1) * (d.cores ?? 1) * (d.threads ?? 1))
    }).catch(() => message.error('加载 CPU 配置失败'))
  }, [name])

  const onValuesChange = (_: Partial<CPUConfig>, all: CPUConfig) => {
    setTotal((all.sockets ?? 1) * (all.cores ?? 1) * (all.threads ?? 1))
  }

  const submit = async (values: CPUConfig) => {
    setLoading(true)
    try { await cpuApi.update(name, values); message.success('CPU 配置已更新') }
    catch { message.error('更新失败') }
    finally { setLoading(false) }
  }

  return (
    <>
      {running && <Alert message="CPU 配置只能在关机状态下修改" type="warning" style={{ marginBottom: 16 }} />}
      <Form form={form} onFinish={submit} onValuesChange={onValuesChange} layout="vertical" style={{ maxWidth: 400 }}>
        <Form.Item name="sockets" label="Sockets" rules={[{ required: true }]}>
          <InputNumber min={1} disabled={running} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="cores" label="Cores（每 Socket）" rules={[{ required: true }]}>
          <InputNumber min={1} disabled={running} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="threads" label="Threads（每 Core）" rules={[{ required: true }]}>
          <InputNumber min={1} disabled={running} style={{ width: '100%' }} />
        </Form.Item>
        <div style={{ marginBottom: 16, color: 'var(--color-cyan)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
          总 vCPU 数：{total}（Sockets × Cores × Threads）
        </div>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} disabled={running}>应用</Button>
        </Form.Item>
      </Form>
    </>
  )
}
