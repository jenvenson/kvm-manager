import { useEffect, useState } from 'react'
import { Table, Button, Drawer, Select, Form, message, Tag } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { networkApi } from '../api/client'
import type { NetworkInterface, HostNetwork } from '../types'

export default function NetworkPanel({ name, running }: { name: string; running: boolean }) {
  const [ifaces, setIfaces] = useState<NetworkInterface[]>([])
  const [hostNets, setHostNets] = useState<HostNetwork[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const load = () => {
    networkApi.listVm(name).then(setIfaces).catch(() => {})
    networkApi.listHost().then(setHostNets).catch(() => {})
  }
  useEffect(() => { load() }, [name])

  const attach = async (values: { source: string; model: string }) => {
    setLoading(true)
    try {
      const net = hostNets.find(n => n.name === values.source)
      await networkApi.attach(name, {
        source: values.source,
        source_type: net?.forward_mode === 'bridge' ? 'bridge' : 'network',
        model: values.model,
      })
      message.success('网卡已添加')
      load()
      setDrawerOpen(false)
      form.resetFields()
    } catch { message.error('添加失败') }
    finally { setLoading(false) }
  }

  const columns = [
    { title: 'TARGET', dataIndex: 'target', key: 'target', render: (v: string) => <span className="mono">{v || '—'}</span> },
    { title: 'MAC', dataIndex: 'mac', key: 'mac', render: (v: string) => <span className="mono" style={{ fontSize: 11 }}>{v}</span> },
    { title: 'SOURCE', dataIndex: 'source', key: 'source', render: (v: string) => <Tag style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{v}</Tag> },
    { title: 'MODEL', dataIndex: 'model', key: 'model', render: (v: string) => <span className="mono">{v}</span> },
  ]

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Button icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>添加网卡</Button>
      </div>
      <Table dataSource={ifaces} columns={columns} rowKey="mac" size="small" pagination={false} />
      <Drawer title="添加网卡" open={drawerOpen} onClose={() => setDrawerOpen(false)} width={360}>
        <Form form={form} layout="vertical" onFinish={attach}>
          <Form.Item name="source" label="虚拟网络" rules={[{ required: true }]}>
            <Select placeholder="选择网络">
              {hostNets.map(n => (
                <Select.Option key={n.name} value={n.name}>
                  {n.name} ({n.forward_mode})
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="model" label="网卡型号" initialValue="virtio">
            <Select>
              <Select.Option value="virtio">virtio（推荐）</Select.Option>
              <Select.Option value="e1000">e1000</Select.Option>
              <Select.Option value="rtl8139">rtl8139</Select.Option>
            </Select>
          </Form.Item>
          {running && (
            <div style={{ color: 'var(--color-green)', fontSize: 12, marginBottom: 12 }}>
              VM 运行中，将热插拔网卡
            </div>
          )}
          <Button type="primary" htmlType="submit" loading={loading} block>添加</Button>
        </Form>
      </Drawer>
    </div>
  )
}
