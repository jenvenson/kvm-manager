import { useEffect, useState } from 'react'
import { Table, message } from 'antd'
import { diskApi } from '../api/client'
import type { DiskInfo } from '../types'

export default function DiskPanel({ name }: { name: string }) {
  const [disks, setDisks] = useState<DiskInfo[]>([])

  const load = () => diskApi.list(name).then(setDisks).catch(() => message.error('加载磁盘失败'))
  useEffect(() => { load() }, [name])

  const cols = [
    { title: '设备', dataIndex: 'dev' },
    { title: '路径', dataIndex: 'path', ellipsis: true },
    { title: '大小 (GB)', dataIndex: 'size_gb' },
    { title: '格式', dataIndex: 'format' },
  ]

  return (
    <Table dataSource={disks} columns={cols} rowKey="dev" pagination={false} />
  )
}
