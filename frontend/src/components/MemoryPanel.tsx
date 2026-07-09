import { useEffect, useState } from 'react'
import { Form, InputNumber, Button, message, Alert } from 'antd'
import { memoryApi } from '../api/client'
import type { MemoryConfig } from '../types'

export default function MemoryPanel({ name, running }: { name: string; running: boolean }) {
  const [form] = Form.useForm<MemoryConfig>()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    memoryApi.get(name).then(d => form.setFieldsValue(d)).catch(() => message.error('加载内存配置失败'))
  }, [name])

  const submit = async (values: MemoryConfig) => {
    setLoading(true)
    try {
      const payload: Partial<MemoryConfig> = { current_mb: values.current_mb }
      if (!running) payload.max_mb = values.max_mb
      await memoryApi.update(name, payload)
      message.success('内存配置已更新')
    } catch { message.error('更新失败') }
    finally { setLoading(false) }
  }

  return (
    <>
      {running && <Alert message="运行中只能修改 current 内存，max 内存需关机后修改" type="info" style={{ marginBottom: 16 }} />}
      <Form form={form} onFinish={submit} layout="vertical" style={{ maxWidth: 400 }}>
        <Form.Item name="current_mb" label="当前内存 (MiB)" rules={[{ required: true }]}>
          <InputNumber min={128} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="max_mb" label="最大内存 (MiB)" rules={[{ required: true }]}>
          <InputNumber min={128} disabled={running} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>应用</Button>
        </Form.Item>
      </Form>
    </>
  )
}
