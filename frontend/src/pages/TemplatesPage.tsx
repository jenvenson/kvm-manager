import { useEffect, useState } from 'react'
import { Row, Col, Button, Modal, Form, Input, Select, message, Popconfirm, Typography, Tag } from 'antd'
import { PlusOutlined, CopyOutlined, DeleteOutlined } from '@ant-design/icons'
import { templateApi, vmApi } from '../api/client'
import type { Template, VMSummary } from '../types'

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [vms, setVms] = useState<VMSummary[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [cloneTarget, setCloneTarget] = useState<Template | null>(null)
  const [form] = Form.useForm()
  const [cloneForm] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const load = () => {
    templateApi.list().then(setTemplates).catch(() => {})
    vmApi.list().then(setVms).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const createTemplate = async (values: { vm_name: string; template_name: string; description?: string }) => {
    setLoading(true)
    try {
      await templateApi.create(values)
      message.success('模板已创建')
      load(); setCreateOpen(false); form.resetFields()
    } catch (e: any) { message.error(e?.response?.data?.detail ?? '创建失败') }
    finally { setLoading(false) }
  }

  const cloneTemplate = async (values: { new_vm_name: string }) => {
    if (!cloneTarget) return
    setLoading(true)
    try {
      await templateApi.clone(cloneTarget.name, values.new_vm_name)
      message.success('VM 已从模板克隆')
      load(); setCloneTarget(null); cloneForm.resetFields()
    } catch (e: any) { message.error(e?.response?.data?.detail ?? '克隆失败') }
    finally { setLoading(false) }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
        <Typography.Title level={4} style={{ color: 'var(--color-cyan)', margin: 0, fontFamily: 'var(--font-mono)', letterSpacing: 2 }}>
          TEMPLATE LIBRARY
        </Typography.Title>
        <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>创建模板</Button>
      </div>

      <Row gutter={[16, 16]}>
        {templates.map(t => (
          <Col key={t.name} xs={24} sm={12} md={8}>
            <div style={{
              background: 'var(--bg-card)', border: '1px solid rgba(0,212,255,0.15)',
              borderRadius: 8, padding: 16, boxShadow: 'var(--glow-cyan)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--color-text)' }}>{t.name}</span>
                <Tag style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{t.size_gb} GB</Tag>
              </div>
              <div style={{ color: 'var(--color-text-dim)', fontSize: 12, marginBottom: 4 }}>
                来源: <span className="mono">{t.source_vm}</span>
              </div>
              <div style={{ color: 'var(--color-text-dim)', fontSize: 11, marginBottom: 12 }}>
                {t.description || '—'}
              </div>
              <div style={{ color: 'var(--color-text-dim)', fontSize: 11, marginBottom: 12 }}>
                {t.created_at.slice(0, 19).replace('T', ' ')}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button size="small" icon={<CopyOutlined />} onClick={() => setCloneTarget(t)}>克隆</Button>
                <Popconfirm title="确认删除此模板？" onConfirm={async () => {
                  await templateApi.delete(t.name); message.success('已删除'); load()
                }}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </div>
            </div>
          </Col>
        ))}
        {templates.length === 0 && (
          <Col span={24} style={{ color: 'var(--color-text-dim)', textAlign: 'center', padding: 40 }}>
            暂无模板，选择关机状态的 VM 创建模板
          </Col>
        )}
      </Row>

      {/* Create modal */}
      <Modal title="创建模板" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <Form form={form} layout="vertical" onFinish={createTemplate}>
          <Form.Item name="vm_name" label="选择 VM（需已关机）" rules={[{ required: true }]}>
            <Select placeholder="选择 VM">
              {vms.filter(v => v.state !== 'running').map(v => (
                <Select.Option key={v.name} value={v.name}>{v.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="template_name" label="模板名称" rules={[{ required: true }]}>
            <Input placeholder="my-template" />
          </Form.Item>
          <Form.Item name="description" label="描述（可选）">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>创建</Button>
        </Form>
      </Modal>

      {/* Clone modal */}
      <Modal title={`从 ${cloneTarget?.name} 克隆`} open={!!cloneTarget} onCancel={() => setCloneTarget(null)} footer={null}>
        <Form form={cloneForm} layout="vertical" onFinish={cloneTemplate}>
          <Form.Item name="new_vm_name" label="新 VM 名称" rules={[{ required: true }]}>
            <Input placeholder="new-vm-name" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>克隆</Button>
        </Form>
      </Modal>
    </div>
  )
}
