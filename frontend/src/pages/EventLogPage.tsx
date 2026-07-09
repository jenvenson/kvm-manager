import { useEffect, useState } from 'react'
import { Table, Tag, Select, Typography, Space, Pagination } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import { eventsApi, vmApi } from '../api/client'
import type { EventLog, VMSummary } from '../types'

export default function EventLogPage() {
  const [data, setData] = useState<{ items: EventLog[]; total: number }>({ items: [], total: 0 })
  const [page, setPage] = useState(1)
  const [vmFilter, setVmFilter] = useState('')
  const [vms, setVms] = useState<VMSummary[]>([])

  useEffect(() => { vmApi.list().then(setVms).catch(() => {}) }, [])
  useEffect(() => {
    eventsApi.list(page, vmFilter).then(r => setData({ items: r.items, total: r.total })).catch(() => {})
  }, [page, vmFilter])

  const columns = [
    {
      title: 'TIME', dataIndex: 'timestamp', key: 'ts', width: 180,
      render: (v: string) => <span className="mono" style={{ fontSize: 11 }}>{v.replace('T', ' ').slice(0, 19)}</span>,
    },
    {
      title: 'VM', dataIndex: 'vm_name', key: 'vm',
      render: (v: string) => v ? <Tag style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{v}</Tag> : <span style={{ color: 'var(--color-text-dim)' }}>—</span>,
    },
    {
      title: 'ACTION', dataIndex: 'path', key: 'path',
      render: (v: string) => <span className="mono" style={{ fontSize: 11, color: 'var(--color-cyan)' }}>{v}</span>,
    },
    {
      title: 'METHOD', dataIndex: 'method', key: 'method',
      render: (v: string) => {
        const colors: Record<string, string> = { POST: '#00d4ff', PUT: '#7b2fff', DELETE: '#ff4d6d' }
        return <Tag style={{ background: 'transparent', border: `1px solid ${colors[v] ?? '#4a6080'}`, color: colors[v] ?? '#4a6080', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{v}</Tag>
      },
    },
    {
      title: 'STATUS', dataIndex: 'success', key: 'status',
      render: (v: boolean) => v
        ? <CheckCircleOutlined style={{ color: 'var(--color-green)' }} />
        : <CloseCircleOutlined style={{ color: 'var(--color-red)' }} />,
    },
  ]

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <Typography.Title level={4} style={{ color: 'var(--color-cyan)', margin: 0, fontFamily: 'var(--font-mono)', letterSpacing: 2 }}>
          EVENT LOG
        </Typography.Title>
      </div>
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="按 VM 筛选"
          style={{ width: 200 }}
          onChange={v => { setVmFilter(v ?? ''); setPage(1) }}
        >
          {vms.map(v => <Select.Option key={v.name} value={v.name}>{v.name}</Select.Option>)}
        </Select>
      </Space>
      <Table
        dataSource={data.items}
        columns={columns}
        rowKey={(r, i) => `${r.timestamp}-${i}`}
        size="small"
        pagination={false}
      />
      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <Pagination
          current={page}
          pageSize={50}
          total={data.total}
          onChange={setPage}
          showTotal={t => `共 ${t} 条`}
          size="small"
        />
      </div>
    </div>
  )
}
