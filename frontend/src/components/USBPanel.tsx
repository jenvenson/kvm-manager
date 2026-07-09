import { useEffect, useState } from 'react'
import { Table, Button, Drawer, List, Popconfirm, message } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { usbApi } from '../api/client'
import type { USBDevice } from '../types'

export default function USBPanel({ name }: { name: string }) {
  const [vmUsb, setVmUsb] = useState<USBDevice[]>([])
  const [hostUsb, setHostUsb] = useState<USBDevice[]>([])
  const [open, setOpen] = useState(false)

  const load = () => usbApi.listVm(name).then(setVmUsb).catch(() => message.error('加载 USB 失败'))
  useEffect(() => { load() }, [name])

  const openDrawer = () => {
    usbApi.listHost().then(setHostUsb).catch(() => message.error('加载宿主机 USB 失败'))
    setOpen(true)
  }

  const attach = async (d: USBDevice) => {
    try { await usbApi.attach(name, { vendor_id: d.vendor_id, product_id: d.product_id }); message.success('USB 已挂载'); setOpen(false); load() }
    catch { message.error('挂载失败') }
  }

  const detach = async (id: string) => {
    try { await usbApi.detach(name, id); message.success('USB 已移除'); load() }
    catch { message.error('移除失败') }
  }

  const cols = [
    { title: '设备', dataIndex: 'name' },
    { title: 'ID', dataIndex: 'id' },
    { title: '操作', render: (_: unknown, r: USBDevice) => (
      <Popconfirm title="确认卸载此 USB？" onConfirm={() => detach(r.id)}>
        <Button danger size="small">卸载</Button>
      </Popconfirm>
    )},
  ]

  return (
    <>
      <Button icon={<PlusOutlined />} onClick={openDrawer} style={{ marginBottom: 16 }}>挂载 USB</Button>
      <Table dataSource={vmUsb} columns={cols} rowKey="id" pagination={false} />
      <Drawer title="选择 USB 设备" open={open} onClose={() => setOpen(false)} width={400}>
        <List dataSource={hostUsb} renderItem={item => (
          <List.Item actions={[<Button key="attach" size="small" onClick={() => attach(item)}>挂载</Button>]}>
            <List.Item.Meta title={item.name} description={item.id} />
          </List.Item>
        )} />
      </Drawer>
    </>
  )
}
