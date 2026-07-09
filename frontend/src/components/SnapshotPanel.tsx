import { useEffect, useState } from 'react'
import { Table, Button, Modal, Form, Input, Popconfirm, message, Space } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { snapshotApi } from '../api/client'
import type { SnapshotInfo } from '../types'

export default function SnapshotPanel({ name }: { name: string }) {
  const [snaps, setSnaps] = useState<SnapshotInfo[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const load = () => snapshotApi.list(name).then(setSnaps).catch(() => message.error('加载快照失败'))
  useEffect(() => { load() }, [name])

  const create = async (values: { name: string; description?: string }) => {
    setLoading(true)
    try { await snapshotApi.create(name, values); message.success('快照已创建'); setOpen(false); form.resetFields(); load() }
    catch { message.error('创建失败') }
    finally { setLoading(false) }
  }

  const revert = async (snap: string) => {
    try { await snapshotApi.revert(name, snap); message.success('已还原，VM 将重启'); load() }
    catch { message.error('还原失败') }
  }

  const del = async (snap: string) => {
    try { await snapshotApi.delete(name, snap); message.success('快照已删除'); load() }
    catch { message.error('删除失败') }
  }

  const cols = [
    { title: '名称', dataIndex: 'name' },
    { title: '描述', dataIndex: 'description' },
    { title: '创建时间', dataIndex: 'created_at' },
    { title: '状态', dataIndex: 'state' },
    { title: '操作', render: (_: unknown, r: SnapshotInfo) => (
      <Space>
        <Popconfirm title="还原到此快照？VM 将重启。" onConfirm={() => revert(r.name)}>
          <Button size="small">还原</Button>
        </Popconfirm>
        <Popconfirm title="确认删除此快照？" onConfirm={() => del(r.name)}>
          <Button danger size="small">删除</Button>
        </Popconfirm>
      </Space>
    )},
  ]

  return (
    <>
      <Button icon={<PlusOutlined />} onClick={() => setOpen(true)} style={{ marginBottom: 16 }}>创建快照</Button>
      <Table dataSource={snaps} columns={cols} rowKey="name" pagination={false} />
      <Modal title="创建快照" open={open} onCancel={() => { setOpen(false); form.resetFields() }} footer={null}>
        <Form form={form} onFinish={create} layout="vertical">
          <Form.Item name="name" label="快照名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={loading}>创建</Button>
              <Button onClick={() => setOpen(false)}>取消</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
