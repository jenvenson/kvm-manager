import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Row, Col, Typography, Button, Table, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import {
  PieChart, Pie, Cell, Tooltip as RTooltip, Legend,
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { vmApi, hostApi } from '../api/client'
import type { VMSummary, VMStats, GuestAgentStatus, HostInfo } from '../types'

const STATE_COLOR: Record<string, string> = {
  running:   '#00ff88',
  shutoff:   '#4a6080',
  paused:    '#ffcc00',
  crashed:   '#ff4d6d',
  suspended: '#7b2fff',
  pmsuspended: '#7b2fff',
}
const STATE_LABEL: Record<string, string> = {
  running:   '运行中',
  shutoff:   '已关机',
  paused:    '已暂停',
  crashed:   '已崩溃',
  suspended: '已挂起',
  pmsuspended: '已挂起',
}

const AGENT_COLOR: Record<string, string> = {
  online:   '#00ff88',
  booting:  '#ffcc00',
  no_agent: '#4a6080',
  offline:  '#4a6080',
}
const AGENT_LABEL: Record<string, string> = {
  online:   '系统正常',
  booting:  '启动中',
  no_agent: '未配置 Agent',
  offline:  '未运行',
}

function SummaryCard({ label, value, color, sub }: { label: string; value: number | string; color: string; sub?: string }) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: `1px solid ${color}30`,
      borderRadius: 8,
      padding: '18px 20px',
      boxShadow: `0 0 12px ${color}15`,
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, width: 4, height: '100%',
        background: color, borderRadius: '8px 0 0 8px',
      }} />
      <div style={{ paddingLeft: 8 }}>
        <div style={{ color: 'var(--color-text-dim)', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 6 }}>
          {label}
        </div>
        <div style={{ color, fontFamily: 'var(--font-mono)', fontSize: 36, fontWeight: 700, lineHeight: 1 }}>
          {value}
        </div>
        {sub && <div style={{ color: 'var(--color-text-dim)', fontSize: 11, fontFamily: 'var(--font-mono)', marginTop: 4 }}>{sub}</div>}
      </div>
    </div>
  )
}

function ChartCard({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid rgba(0,212,255,0.15)',
      borderRadius: 8,
      padding: '16px 20px',
      ...style,
    }}>
      <div style={{ color: 'var(--color-cyan)', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 16 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

const RTOOLTIP_STYLE = {
  background: 'var(--bg-secondary)',
  border: '1px solid rgba(0,212,255,0.3)',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
}

export default function OverviewPage() {
  const navigate = useNavigate()
  const [vms, setVms] = useState<VMSummary[]>([])
  const [statsMap, setStatsMap] = useState<Record<string, VMStats>>({})
  const [agentMap, setAgentMap] = useState<Record<string, GuestAgentStatus>>({})
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null)
  const [updatedAt, setUpdatedAt] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [list, host] = await Promise.all([vmApi.list(), hostApi.info()])
      setVms(list)
      setHostInfo(host)
      setUpdatedAt(new Date().toLocaleTimeString('zh-CN'))

      const running = list.filter(v => v.state === 'running')
      running.forEach(v => {
        vmApi.getStats(v.name)
          .then(s => setStatsMap(prev => ({ ...prev, [v.name]: s })))
          .catch(() => {})
        vmApi.getGuestAgent(v.name)
          .then(a => setAgentMap(prev => ({ ...prev, [v.name]: a })))
          .catch(() => {})
      })
    } catch {}
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])

  // ── Computed aggregates ──────────────────────────────────────────────────

  const stateCounts = vms.reduce<Record<string, number>>((acc, v) => {
    acc[v.state] = (acc[v.state] ?? 0) + 1
    return acc
  }, {})

  const runningVms = vms.filter(v => v.state === 'running')
  const totalVcpus = vms.reduce((s, v) => s + v.vcpus, 0)
  const totalMemMb = vms.reduce((s, v) => s + v.memory_mb, 0)

  const stateDonutData = Object.entries(stateCounts).map(([state, count]) => ({
    name: STATE_LABEL[state] ?? state,
    value: count,
    color: STATE_COLOR[state] ?? '#4a6080',
  }))

  const resourceBarData = runningVms.map(v => ({
    name: v.name,
    cpu: Math.round(statsMap[v.name]?.cpu_percent ?? 0),
    mem: Math.round(statsMap[v.name]?.mem_percent ?? 0),
  }))

  const agentCounts = runningVms.reduce<Record<string, number>>((acc, v) => {
    const status = agentMap[v.name]?.status ?? 'unknown'
    acc[status] = (acc[status] ?? 0) + 1
    return acc
  }, {})

  const vmTableData = vms.map(v => ({
    key: v.name,
    name: v.name,
    state: v.state,
    vcpus: v.vcpus,
    memoryMb: v.memory_mb,
    cpu: statsMap[v.name]?.cpu_percent,
    mem: statsMap[v.name]?.mem_percent,
    agent: agentMap[v.name]?.status,
    agentOs: agentMap[v.name]?.os_name,
  }))

  const vmCols = [
    {
      title: '名称', dataIndex: 'name', key: 'name',
      render: (name: string) => (
        <span
          style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-cyan)', cursor: 'pointer' }}
          onClick={() => navigate(`/vm/${name}`)}
        >{name}</span>
      ),
    },
    {
      title: '状态', dataIndex: 'state', key: 'state', width: 100,
      render: (s: string) => (
        <Tag style={{ background: 'transparent', border: `1px solid ${STATE_COLOR[s] ?? '#4a6080'}`, color: STATE_COLOR[s] ?? '#4a6080', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
          {STATE_LABEL[s] ?? s.toUpperCase()}
        </Tag>
      ),
    },
    { title: 'vCPU', dataIndex: 'vcpus', key: 'vcpus', width: 70, render: (v: number) => <span className="mono">{v}</span> },
    { title: '内存', dataIndex: 'memoryMb', key: 'memoryMb', width: 90, render: (v: number) => <span className="mono">{v >= 1024 ? `${(v / 1024).toFixed(0)}GB` : `${v}MB`}</span> },
    {
      title: 'CPU %', dataIndex: 'cpu', key: 'cpu', width: 90,
      render: (v?: number) => v != null
        ? <span className="mono" style={{ color: v > 80 ? 'var(--color-red)' : v > 50 ? 'var(--color-yellow)' : 'var(--color-green)' }}>{v.toFixed(1)}%</span>
        : <span style={{ color: 'var(--color-text-dim)' }}>—</span>,
    },
    {
      title: 'MEM %', dataIndex: 'mem', key: 'mem', width: 90,
      render: (v?: number) => v != null
        ? <span className="mono" style={{ color: v > 80 ? 'var(--color-red)' : v > 60 ? 'var(--color-yellow)' : 'var(--color-purple)' }}>{v.toFixed(1)}%</span>
        : <span style={{ color: 'var(--color-text-dim)' }}>—</span>,
    },
    {
      title: 'OS 状态', dataIndex: 'agent', key: 'agent', width: 130,
      render: (status?: string) => {
        if (!status) return <span style={{ color: 'var(--color-text-dim)' }}>—</span>
        return (
          <span style={{ color: AGENT_COLOR[status] ?? '#4a6080', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            ● {AGENT_LABEL[status] ?? status}
          </span>
        )
      },
    },
    {
      title: 'OS 类型', dataIndex: 'agentOs', key: 'agentOs',
      render: (os?: string) => os
        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{os}</span>
        : <span style={{ color: 'var(--color-text-dim)' }}>—</span>,
    },
  ]

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <Typography.Title level={4} style={{ color: 'var(--color-cyan)', margin: 0, fontFamily: 'var(--font-mono)', letterSpacing: 2 }}>
            SYSTEM OVERVIEW
          </Typography.Title>
          {updatedAt && (
            <span style={{ color: 'var(--color-text-dim)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              LAST UPDATED: {updatedAt}
            </span>
          )}
        </div>
        <Button icon={<ReloadOutlined />} size="small" onClick={load} loading={loading}>刷新</Button>
      </div>

      {/* Top stat cards */}
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        <Col xs={12} sm={6}>
          <SummaryCard label="运行中" value={stateCounts.running ?? 0} color="#00ff88" />
        </Col>
        <Col xs={12} sm={6}>
          <SummaryCard label="已关机" value={stateCounts.shutoff ?? 0} color="#4a6080" />
        </Col>
        <Col xs={12} sm={6}>
          <SummaryCard
            label="异常 / 暂停"
            value={(stateCounts.crashed ?? 0) + (stateCounts.paused ?? 0) + (stateCounts.suspended ?? 0) + (stateCounts.pmsuspended ?? 0)}
            color="#ffcc00"
          />
        </Col>
        <Col xs={12} sm={6}>
          <SummaryCard label="总计" value={vms.length} color="var(--color-cyan)"
            sub={`${totalVcpus} vCPU · ${(totalMemMb / 1024).toFixed(0)} GB 已分配`} />
        </Col>
      </Row>

      {/* Charts row */}
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        {/* State donut */}
        <Col xs={24} md={10}>
          <ChartCard title="VM 状态分布" style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie
                  data={stateDonutData}
                  cx="50%" cy="50%"
                  innerRadius="55%" outerRadius="78%"
                  dataKey="value"
                  paddingAngle={3}
                >
                  {stateDonutData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} stroke="transparent" />
                  ))}
                </Pie>
                <RTooltip
                  formatter={(v: number, name: string) => [`${v} 台`, name]}
                  contentStyle={RTOOLTIP_STYLE}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ color: '#c8d0e0', fontSize: 12 }}
                  formatter={(value) => <span style={{ color: '#c8d0e0' }}>{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
        </Col>

        {/* Resource bars */}
        <Col xs={24} md={14}>
          <ChartCard title="运行中 VM 资源使用率" style={{ height: 300 }}>
            {runningVms.length === 0 ? (
              <div style={{ color: 'var(--color-text-dim)', textAlign: 'center', paddingTop: 60, fontSize: 13 }}>
                无运行中的 VM
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={resourceBarData} layout="vertical" margin={{ left: 0, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,212,255,0.08)" />
                  <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fill: 'var(--color-text-dim)', fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" width={90} tick={{ fill: 'var(--color-cyan)', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
                  <RTooltip formatter={(v: number) => `${v}%`} contentStyle={RTOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ color: '#c8d0e0', fontSize: 12 }} formatter={(v) => <span style={{ color: '#c8d0e0' }}>{v}</span>} />
                  <Bar dataKey="cpu" name="CPU" fill="#00d4ff" radius={[0, 3, 3, 0]} maxBarSize={14} />
                  <Bar dataKey="mem" name="内存" fill="#7b2fff" radius={[0, 3, 3, 0]} maxBarSize={14} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </ChartCard>
        </Col>
      </Row>

      {/* Resource summary + Agent health */}
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        {/* Host / resource summary */}
        <Col xs={24} md={12}>
          <ChartCard title="资源汇总">
            <Row gutter={[0, 12]}>
              {[
                { label: '总分配 vCPU', value: `${totalVcpus} 核`, color: 'var(--color-cyan)' },
                { label: '总分配内存', value: `${(totalMemMb / 1024).toFixed(1)} GB`, color: 'var(--color-purple)' },
                hostInfo && { label: '宿主机 CPU', value: `${hostInfo.host_cpus} 核`, color: 'var(--color-text)' },
                hostInfo && { label: '宿主机总内存', value: `${(hostInfo.host_memory_mb / 1024).toFixed(1)} GB`, color: 'var(--color-text)' },
                hostInfo && { label: '宿主机空闲内存', value: `${(hostInfo.host_memory_free_mb / 1024).toFixed(1)} GB`, color: 'var(--color-green)' },
              ].filter(Boolean).map((item: any, i) => (
                <Col xs={12} key={i}>
                  <div style={{ padding: '8px 12px', background: 'rgba(0,212,255,0.04)', borderRadius: 4, border: '1px solid rgba(0,212,255,0.1)' }}>
                    <div style={{ color: 'var(--color-text-dim)', fontSize: 11 }}>{item.label}</div>
                    <div style={{ color: item.color, fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700 }}>{item.value}</div>
                  </div>
                </Col>
              ))}
            </Row>
          </ChartCard>
        </Col>

        {/* Agent health */}
        <Col xs={24} md={12}>
          <ChartCard title="Guest Agent 健康度（运行中 VM）">
            {runningVms.length === 0 ? (
              <div style={{ color: 'var(--color-text-dim)', fontSize: 13 }}>无运行中的 VM</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(['online', 'booting', 'no_agent'] as const).map(status => {
                  const count = agentCounts[status] ?? 0
                  const total = runningVms.length
                  const pct = total > 0 ? (count / total) * 100 : 0
                  return (
                    <div key={status}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ color: AGENT_COLOR[status], fontSize: 13 }}>
                          ● {AGENT_LABEL[status]}
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text)', fontSize: 13 }}>
                          {count} / {total}
                        </span>
                      </div>
                      <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 3, height: 6, overflow: 'hidden' }}>
                        <div style={{
                          width: `${pct}%`, height: '100%',
                          background: AGENT_COLOR[status],
                          borderRadius: 3, transition: 'width 0.5s ease',
                        }} />
                      </div>
                    </div>
                  )
                })}
                {Object.keys(agentCounts).filter(s => !['online', 'booting', 'no_agent'].includes(s)).map(s => (
                  <div key={s} style={{ color: 'var(--color-text-dim)', fontSize: 12 }}>
                    {AGENT_LABEL[s] ?? s}: {agentCounts[s]}
                  </div>
                ))}
                {Object.keys(agentMap).length < runningVms.length && (
                  <div style={{ color: 'var(--color-text-dim)', fontSize: 11, fontStyle: 'italic' }}>
                    正在加载 Agent 状态...
                  </div>
                )}
              </div>
            )}
          </ChartCard>
        </Col>
      </Row>

      {/* Full VM list */}
      <ChartCard title="全部虚拟机">
        <Table
          dataSource={vmTableData}
          columns={vmCols}
          size="small"
          pagination={false}
          rowClassName={row => row.state === 'crashed' ? 'vm-critical-border' : ''}
          onRow={row => ({ onClick: () => navigate(`/vm/${row.name}`) })}
          style={{ cursor: 'pointer' }}
        />
      </ChartCard>
    </div>
  )
}
